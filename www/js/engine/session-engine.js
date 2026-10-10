// The heart of the app.  Takes speech chunks, returns a smooth, ordered transcript:
//
//   chunk ─► speech-to-text ─► clean ─► Arabic? ─► wait briefly for the NEXT sentence ─► translate
//                                  └─► English?  ─► show as "Interpreter" (never translated)
//
// Design rules that make the output calm instead of choppy:
//   1. COMMIT ONCE — a translation is shown only when final and is never rewritten afterwards.
//   2. LOOK-AHEAD — each slice is translated with the following slice visible (when it arrives within
//      a few seconds), so sentences that straddle a pause are rendered as one thought.
//   3. CONTINUITY — the model is shown the English already on screen and told to continue it seamlessly.
//   4. ORDER — results are committed strictly in speech order even if requests finish out of order.
import { uid, sleep } from "../util.js";
import { encodeWav } from "../audio/wav.js";
import { Glossary, buildWhisperPrompt } from "./glossary.js";
import { cleanTranscript } from "./hallucination.js";
import { ApiError } from "./errors.js";
import { scriptLang, langCode, ARABIC_LOOKALIKES, lastWords } from "./arabic.js";
import { buildSystemPrompt, buildUserPrompt, cleanTranslation } from "./prompts.js";
import { DELAY_PRESETS } from "../settings.js";

export class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(evt, fn) {
    (this.handlers[evt] ||= new Set()).add(fn);
    return () => this.handlers[evt].delete(fn);
  }
  emit(evt, payload) {
    for (const fn of this.handlers[evt] || []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

const NOISE_ENGLISH = /^(thank you|thanks|thanks for watching|bye|you|okay|ok|so|yeah|um|uh|hmm)[.!\s]*$/i;

export class LectureEngine extends Emitter {
  constructor({ router, settings, now = () => Date.now(), maxParallelStt = 2 } = {}) {
    super();
    this.router = router;
    this.settings = settings;
    this.now = now;
    this.cfg = DELAY_PRESETS[settings.delay] || DELAY_PRESETS.balanced;
    this.glossary = new Glossary(settings.customGlossary || []);
    this.userTerms = (settings.customGlossary || []).map((e) => e.ar.split("|")[0].trim()).filter(Boolean);
    this.system = buildSystemPrompt({ termStyle: settings.termStyle, honorifics: settings.honorifics });
    this.entries = [];
    this.audio = new Map(); // entry id -> wav (kept until the speech is transcribed)
    this.seq = 0;
    this.arTail = ""; // last Arabic transcribed (prompt + de-duplication)
    this.translating = false;
    this.finishing = false;
    this.halted = false;
    this.gate = null;
    this.timer = null;
    this.slots = maxParallelStt;
    this.waiters = [];
    this.commitChain = Promise.resolve();
    this.abort = new AbortController();
    this.stopped = false;
  }

  // ---- input ---------------------------------------------------------------------------------
  /** @param {{pcm:Float32Array,startMs:number,endMs:number,voicedMs:number}} chunk */
  ingestChunk(chunk) {
    if (this.stopped) return;
    const e = { id: uid("e"), seq: ++this.seq, t0: chunk.startMs / 1000, t1: chunk.endMs / 1000, kind: "lecture", ar: "", en: "", state: "transcribing", attempts: 0 };
    if (this.breakNext) {
      e.breakBefore = true; // recording was paused: start a fresh paragraph
      this.breakNext = false;
    }
    this.entries.push(e);
    this.audio.set(e.id, encodeWav(chunk.pcm));
    this.emit("entry", e);
    this._queueStt(e);
  }

  _queueStt(e) {
    const p = this._stt(e);
    this.commitChain = this.commitChain.then(() =>
      p.then(
        (res) => this._commitStt(e, res),
        (err) => this._sttFailed(e, err)
      )
    );
  }

  // ---- speech to text ------------------------------------------------------------------------
  async _acquire() {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
  }
  _release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.slots++;
  }

  async _waitIfHalted() {
    while (this.halted && !this.stopped) await this.gate;
  }

  async _stt(e) {
    await this._waitIfHalted();
    await this._acquire();
    try {
      const wav = this.audio.get(e.id);
      if (!wav) throw new ApiError("Audio no longer available", { kind: "bad_request" });
      const language = this.settings.lectureLang === "ar" ? "ar" : undefined;
      const prompt = buildWhisperPrompt({ userTerms: this.userTerms, tail: this.arTail });
      const call = (lang) => (item) => this.router.providers[item.provider].transcribe(wav, { model: item.model, language: lang, prompt, signal: this.abort.signal });
      let { value: res } = await this.router.run("stt", call(language), { signal: this.abort.signal });
      // Whisper sometimes calls Arabic speech Persian/Urdu: same script, wrong words. Re-run as Arabic.
      if (!language && ARABIC_LOOKALIKES.has(langCode(res.language)) && scriptLang(res.text) === "ar") {
        ({ value: res } = await this.router.run("stt", call("ar"), { signal: this.abort.signal }));
      }
      return res;
    } finally {
      this._release();
    }
  }

  _sttFailed(e, err) {
    const ae = ApiError.from(err);
    if (ae.kind === "aborted" || this.stopped) return this._drop(e);
    if (ae.kind === "auth") {
      e.state = "error"; // keep the audio; resume() re-queues it once the key is fixed
      e.error = "Waiting for a working API key";
      this.emit("entry", e);
      this._halt(ae.message);
      return;
    }
    e.state = "error";
    e.error = ae.kind === "network" ? "No connection" : ae.message;
    this.emit("entry", e);
    if (e.attempts < 3 && ae.kind !== "bad_request") {
      e.attempts++;
      setTimeout(() => this.retry(e.id), 12000 * e.attempts);
    }
  }

  _commitStt(e, res) {
    this.audio.delete(e.id);
    const guess = scriptLang(res.text);
    const text = cleanTranscript(res, guess === "ar" ? this.arTail : "");
    const lang = scriptLang(text);
    if (!text || (lang !== "ar" && lang !== "en")) return this._drop(e);

    if (lang === "en") {
      if (NOISE_ENGLISH.test(text.trim())) return this._drop(e);
      e.kind = "interpreter";
      e.en = text;
      e.state = "done";
      // everything the sheikh said before the interpreter began no longer needs to wait for look-ahead
      for (const x of this.entries) if (x.seq < e.seq && x.state === "awaiting") x.forceReady = true;
      this.emit("entry", e);
    } else {
      e.kind = "lecture";
      e.ar = text;
      e.state = "awaiting";
      e.sttDoneAt = this.now();
      this.arTail = lastWords((this.arTail + " " + text).trim(), 40);
      this.emit("entry", e);
    }
    this._pump();
  }

  _drop(e) {
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    this.audio.delete(e.id);
    this.emit("remove", e);
    this._pump();
  }

  // ---- translation ---------------------------------------------------------------------------
  _pump() {
    if (this.translating || this.halted || this.stopped) return;
    clearTimeout(this.timer);
    const idx = this.entries.findIndex((x) => x.state === "awaiting");
    if (idx < 0) return;
    // never translate ahead of an earlier chunk that is still being transcribed
    if (this.entries.slice(0, idx).some((x) => x.state === "transcribing")) return;
    const e = this.entries[idx];
    const next = this.entries[idx + 1];
    const wait = this.cfg.lookaheadWaitMs;
    const haveNext = next && next.state !== "transcribing" && next.state !== "error";
    const waited = this.now() - e.sttDoneAt;
    const ready = this.finishing || e.forceReady || wait === 0 || haveNext || waited >= wait;
    if (!ready) {
      this.timer = setTimeout(() => this._pump(), Math.max(50, wait - waited));
      return;
    }
    this._translate(e, idx);
  }

  async _translate(e, idx) {
    this.translating = true;
    e.state = "translating";
    this.emit("entry", e);
    try {
      const before = this.entries.slice(0, idx);
      const prevLecture = [...before].reverse().find((x) => x.kind === "lecture" && x.ar);
      const nextE = this.entries[idx + 1];
      const nextAr = nextE && nextE.kind === "lecture" && nextE.state !== "error" ? nextE.ar : "";
      const recent = lastWords(
        before
          .filter((x) => x.state === "done" && x.en)
          .slice(-5)
          .map((x) => (x.kind === "interpreter" ? `(Interpreter: ${x.en})` : x.en))
          .join(" "),
        70
      );
      const glossary = this.glossary.find([prevLecture?.ar, e.ar, nextAr].filter(Boolean).join(" "), 14);
      const user = buildUserPrompt({ current: e.ar, previous: prevLecture?.ar || "", next: nextAr, recent, glossary, context: this.settings.context || "" });
      const { value, item } = await this.router.run(
        "llm",
        (it) => this.router.providers[it.provider].chat({ model: it.model, system: this.system, user, signal: this.abort.signal }),
        { signal: this.abort.signal }
      );
      const en = cleanTranslation(value);
      if (!en) throw new ApiError("The translator returned nothing", { kind: "unknown" });
      e.en = en;
      e.model = item.id;
      e.state = "done";
      this.emit("entry", e);
    } catch (err) {
      const ae = ApiError.from(err);
      if (this.stopped || ae.kind === "aborted") {
        e.state = "awaiting";
      } else if (ae.kind === "auth") {
        e.state = "awaiting";
        this._halt(ae.message);
      } else {
        e.state = "error";
        e.error = ae.kind === "quota" || ae.kind === "rate" ? "Free limit reached — tap to retry" : ae.message;
        this.emit("entry", e);
      }
    } finally {
      this.translating = false;
      this._pump();
    }
  }

  markBreak() {
    this.breakNext = true;
  }

  // ---- control -------------------------------------------------------------------------------
  retry(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e || e.state !== "error" || this.stopped) return;
    e.error = "";
    if (this.audio.has(e.id)) {
      e.state = "transcribing";
      this.emit("entry", e);
      this._queueStt(e);
    } else {
      e.state = "awaiting";
      e.forceReady = true;
      e.sttDoneAt = this.now();
      this.emit("entry", e);
      this._pump();
    }
  }

  _halt(message) {
    if (this.halted) return;
    this.halted = true;
    this.gate = new Promise((r) => (this.openGate = r));
    this.emit("halt", message);
    this.emit("notice", { level: "error", code: "halt", text: message });
  }

  /** Call after the user fixed their key: swap in a fresh router and continue where we stopped. */
  resume(router) {
    if (router) this.router = router;
    this.router.reset();
    if (this.halted) {
      this.halted = false;
      this.openGate && this.openGate();
    }
    for (const e of [...this.entries]) if (e.state === "error") this.retry(e.id);
    this._pump();
  }

  _busy() {
    return this.entries.some((x) => x.state === "transcribing" || x.state === "awaiting" || x.state === "translating");
  }

  /** Let everything in flight finish (no more look-ahead waiting). */
  async finish(timeoutMs = 45000) {
    this.finishing = true;
    this._pump();
    const t0 = this.now();
    while (this._busy() && !this.halted && this.now() - t0 < timeoutMs) {
      await sleep(120);
      this._pump();
    }
    this.stop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
    if (this.openGate) this.openGate();
  }

  /** Plain, serialisable copy (what gets saved). */
  snapshot() {
    return this.entries
      .filter((e) => e.state === "done" || (e.kind === "lecture" && e.ar))
      .map(({ id, seq, t0, t1, kind, ar, en, state, breakBefore }) => ({ id, seq, t0, t1, kind, ar, en, state: state === "done" ? "done" : "partial", ...(breakBefore ? { breakBefore } : {}) }));
  }
}
