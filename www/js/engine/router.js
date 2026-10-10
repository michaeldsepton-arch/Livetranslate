// Picks which service/model handles each call and keeps going when one is rate-limited, out of
// daily quota, down, or has a bad key.  Pure logic: providers are injected (easy to test).
import { ApiError } from "./errors.js";
import { pickGroqModels, pickGeminiModels } from "../providers/models.js";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Router {
  /**
   * @param {{groq?:object, gemini?:object}} providers   keyed providers (absent = no key)
   * @param {{preferGemini?:boolean, models?:object}} opts
   */
  constructor(providers, { preferGemini = false, overrides = {}, now = Date.now, sleep = defaultSleep, onNotice = () => {}, usage = null } = {}) {
    this.providers = providers;
    this.usage = usage; // optional UsageTracker: lets us pace requests under each model's per-minute limit
    this.preferGemini = preferGemini;
    this.overrides = overrides; // {stt, llm, gemini}: user-typed model ids (advanced)
    this.now = now;
    this.sleep = sleep;
    this.onNotice = onNotice;
    this.models = {
      groq: pickGroqModels(null),
      gemini: pickGeminiModels(null),
    };
    this.cool = new Map(); // item id -> epoch ms until which it is skipped
    this.dead = new Set(); // providers whose key was rejected
    this.bad = new Set(); // model ids that no longer exist
    this.lastNotice = "";
  }

  /** Ask each service which models exist right now.  Never throws (falls back to defaults). */
  async init() {
    const tasks = [];
    if (this.providers.groq)
      tasks.push(
        this.providers.groq.listModels().then((l) => (this.models.groq = pickGroqModels(l))).catch((e) => {
          if (e instanceof ApiError && e.kind === "auth") this.dead.add("groq");
        })
      );
    if (this.providers.gemini)
      tasks.push(
        this.providers.gemini.listModels().then((l) => (this.models.gemini = pickGeminiModels(l))).catch((e) => {
          if (e instanceof ApiError && e.kind === "auth") this.dead.add("gemini");
        })
      );
    await Promise.all(tasks);
    if (this.overrides.stt) this.models.groq.stt = [this.overrides.stt, ...this.models.groq.stt.filter((m) => m !== this.overrides.stt)];
    if (this.overrides.llm) this.models.groq.llm = [this.overrides.llm, ...this.models.groq.llm.filter((m) => m !== this.overrides.llm)];
    if (this.overrides.gemini) {
      for (const k of ["stt", "llm"]) this.models.gemini[k] = [this.overrides.gemini, ...this.models.gemini[k].filter((m) => m !== this.overrides.gemini)];
    }
  }

  reset() {
    this.cool.clear();
    this.dead.clear();
    this.bad.clear();
    this.lastNotice = "";
  }

  /** True when no usable provider remains (all keys rejected / none configured). */
  get exhausted() {
    return this.chain("stt").length === 0 || this.chain("llm").length === 0;
  }

  chain(kind) {
    const order = this.preferGemini ? ["gemini", "groq"] : ["groq", "gemini"];
    const items = [];
    for (const p of order) {
      if (!this.providers[p] || this.dead.has(p)) continue;
      for (const model of this.models[p][kind]) {
        const id = `${p}:${model}`;
        if (!this.bad.has(id)) items.push({ provider: p, model, id });
      }
    }
    return items;
  }

  notice(code, level, text) {
    if (this.lastNotice === code) return;
    this.lastNotice = code;
    this.onNotice({ code, level, text });
  }

  /**
   * Run fn(item) against the best available item, switching on failure.
   * @returns {Promise<{value:any,item:object}>}
   */
  async run(kind, fn, { signal, maxWaitMs = 150000 } = {}) {
    const start = this.now();
    let netFails = 0;
    for (;;) {
      if (signal && signal.aborted) throw new ApiError("Cancelled", { kind: "aborted" });
      const chain = this.chain(kind);
      if (!chain.length) throw new ApiError("No working API key. Add or fix your key in Settings.", { kind: "auth" });
      const t = this.now();
      const pace = (it) => (this.usage ? this.usage.pace(it.id) : 0);
      const ready = chain.filter((it) => (this.cool.get(it.id) || 0) <= t && pace(it) === 0);
      if (!ready.length) {
        const wait = Math.max(300, Math.min(...chain.map((it) => Math.max((this.cool.get(it.id) || 0) - t, pace(it)))));
        if (this.now() - start + wait > maxWaitMs) throw new ApiError("Free limit reached for now", { kind: "quota" });
        if (wait >= 3000) this.notice("rate", "warn", `Free limit reached — continuing in ${Math.ceil(wait / 1000)}s`);
        await this.sleep(Math.min(wait, 15000));
        continue;
      }
      const item = ready[0];
      if (this.usage) this.usage.touch(item.id);
      try {
        const value = await fn(item);
        this.notice("ok", "ok", "");
        return { value, item };
      } catch (err) {
        const e = ApiError.from(err, item.provider);
        switch (e.kind) {
          case "aborted":
            throw e;
          case "auth":
            this.dead.add(item.provider);
            this.notice(`auth-${item.provider}`, "error", `${item.provider === "groq" ? "Groq" : "Gemini"} key was rejected. Check it in Settings.`);
            continue;
          case "model":
            this.bad.add(item.id);
            continue;
          case "quota":
            this.cool.set(item.id, t + Math.max(e.retryAfterMs, 30 * 60000));
            this.notice(`quota-${item.id}`, "warn", `Daily limit reached on ${item.model} — switching.`);
            continue;
          case "rate":
            this.cool.set(item.id, t + Math.min(Math.max(e.retryAfterMs, 1500), 120000));
            continue;
          case "server":
            this.cool.set(item.id, t + 8000);
            continue;
          case "network":
            this.notice("offline", "warn", "No internet connection — retrying…");
            if (++netFails > 3) throw e;
            await this.sleep(1500 * netFails);
            continue;
          default:
            throw e;
        }
      }
    }
  }
}
