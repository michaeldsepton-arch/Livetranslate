// Picks which service/model handles each call and keeps going when one is rate-limited, out of
// daily quota, down, or has a bad key.  Pure logic: providers are injected (easy to test).
import { ApiError, label } from "./errors.js";
import { pickGroqModels, pickGeminiModels, pickOpenAiModels, isWeakModel } from "../providers/models.js";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// When every strong model is briefly unavailable (a per-minute limit, a hiccup) wait up to this long for one, instead of
// switching to a weaker model and changing the translation's quality and style mid-lecture.
const STRONG_WAIT_MS = 30000;

export class Router {
  /**
   * @param {{groq?:object, gemini?:object}} providers   keyed providers (absent = no key)
   * @param {{preferGemini?:boolean, engines?:object, models?:object}} opts
   */
  constructor(providers, { preferGemini = false, engines = {}, overrides = {}, now = Date.now, sleep = defaultSleep, onNotice = () => {}, usage = null } = {}) {
    this.providers = providers;
    this.usage = usage; // optional UsageTracker: lets us pace requests under each model's per-minute limit
    this.preferGemini = preferGemini;
    // which engine to try first, per stage: speech ("stt") and translation ("llm").
    // stt: auto | groq | groq-turbo | gemini | openai     llm: auto | groq | gemini | openai.   A missing key simply falls through to the other.
    this.engines = { stt: engines.stt || "auto", llm: engines.llm || "auto" };
    this.overrides = overrides; // {stt, llm, gemini}: user-typed model ids (advanced)
    this.now = now;
    this.sleep = sleep;
    this.onNotice = onNotice;
    this.models = {
      groq: pickGroqModels(null),
      gemini: pickGeminiModels(null),
      openai: pickOpenAiModels(null),
    };
    this.cool = new Map(); // item id -> epoch ms until which it is skipped
    this.dead = new Set(); // providers whose key was rejected
    this.noCredit = new Set(); // providers that reported "out of credit": left out until the user says they have added some
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
    if (this.providers.openai)
      tasks.push(
        this.providers.openai.listModels().then((l) => (this.models.openai = pickOpenAiModels(l))).catch((e) => {
          if (e instanceof ApiError && e.kind === "auth") this.dead.add("openai");
        })
      );
    await Promise.all(tasks);
    if (this.overrides.stt) this.models.groq.stt = [this.overrides.stt, ...this.models.groq.stt.filter((m) => m !== this.overrides.stt)];
    if (this.overrides.llm) this.models.groq.llm = [this.overrides.llm, ...this.models.groq.llm.filter((m) => m !== this.overrides.llm)];
    if (this.overrides.openai) this.models.openai.llm = [this.overrides.openai, ...this.models.openai.llm.filter((m) => m !== this.overrides.openai)];
    if (this.overrides.gemini) {
      for (const k of ["stt", "llm"]) this.models.gemini[k] = [this.overrides.gemini, ...this.models.gemini[k].filter((m) => m !== this.overrides.gemini)];
    }
  }

  reset() {
    this.noCredit.clear();
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
    const pref = this.engines[kind] || "auto";
    // the chosen service goes first, then the others as fallbacks.  "Auto" starts with OpenAI when it has a key (it is paid, so
    // there is no free allowance to run out), otherwise Groq.
    const first = pref === "gemini" || pref === "openai" ? pref : pref === "auto" && this.preferGemini ? "gemini" : pref === "auto" && this.providers.openai ? "openai" : "groq";
    const order = [first, ...["groq", "gemini", "openai"].filter((p) => p !== first)];
    const items = [];
    const weakItems = [];
    for (const p of order) {
      if (!this.providers[p] || this.dead.has(p) || this.noCredit.has(p)) continue;
      let models = this.models[p][kind];
      if (p === "groq" && kind === "stt" && pref === "groq-turbo") models = [...models].sort((a, b) => Number(/turbo/.test(b)) - Number(/turbo/.test(a)));
      for (const model of models) {
        const id = `${p}:${model}`;
        if (this.bad.has(id)) continue;
        const weak = isWeakModel(p, kind, model) && !this.isOverride(p, kind, model);
        (weak ? weakItems : items).push({ provider: p, model, id, weak });
      }
    }
    return [...items, ...weakItems]; // every strong model of every service before any weak one
  }

  /** A model the user typed in Settings is always trusted. */
  isOverride(provider, kind, model) {
    const o = this.overrides || {};
    return model === (provider === "groq" ? o[kind] : o[provider]);
  }

  notice(code, level, text, extra = {}) {
    if (this.lastNotice === code) return;
    this.lastNotice = code;
    this.onNotice({ code, level, text, ...extra });
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
      if (!chain.length) {
        if (this.noCredit.size) {
          const who = [...this.noCredit].map(label).join(" and ");
          throw new ApiError(`${who} credit has run out. Add credit, then tap Retry.`, { kind: "auth", credit: true });
        }
        throw new ApiError("No working API key. Add or fix your key in Settings.", { kind: "auth" });
      }
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
      if (!ready.some((it) => !it.weak)) {
        const strong = chain.filter((it) => !it.weak);
        if (strong.length) {
          const soonest = Math.min(...strong.map((it) => Math.max((this.cool.get(it.id) || 0) - t, pace(it))));
          if (soonest <= STRONG_WAIT_MS && this.now() - start + soonest <= maxWaitMs) {
            if (soonest >= 3000) this.notice("rate", "warn", `Waiting ${Math.ceil(soonest / 1000)}s for the main model`);
            await this.sleep(Math.max(300, Math.min(soonest, 15000)));
            continue;
          }
        }
      }
      const item = ready.find((it) => !it.weak) || ready[0];
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
            this.notice(`auth-${item.provider}`, "error", `${label(item.provider)} key was rejected. Check it in Settings.`);
            continue;
          case "model":
            this.bad.add(item.id);
            continue;
          case "quota":
            if (e.credit) {
              this.noCredit.add(item.provider);
              const others = [...new Set(this.chain(kind).map((it) => label(it.provider)))];
              this.notice(`credit-${item.provider}`, others.length ? "warn" : "error", others.length ? `${label(item.provider)} credit has run out — now using ${others.join(" / ")}.` : `${label(item.provider)} credit has run out. Add credit, then tap Retry.`, { provider: item.provider, credit: true });
              continue;
            }
            this.cool.set(item.id, t + Math.max(e.retryAfterMs, 30 * 60000));
            this.notice(`quota-${item.id}`, "warn", item.provider === "openai" ? "OpenAI credit has run out — switching to the other services." : `Daily limit reached on ${item.model} — switching.`);
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
