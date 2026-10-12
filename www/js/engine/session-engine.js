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
import { Glossary, buildWhisperPrompt, buildOpenAiPrompt } from "./glossary.js";
import { cleanTranscript, stripPrimerEcho } from "./hallucination.js";
import { ApiError } from "./errors.js";
import { scriptLang, langCode, ARABIC_LOOKALIKES, lastWords } from "./arabic.js";
import { buildSystemPrompt, buildUserPrompt, cleanTranslation } from "./prompts.js";
import { looksLikeEnglish, looksTransliterated, splitByLanguage, englishizeFormulae, englishWords, knownTermShare, needsStop } from "./english.js";
import { DELAY_PRESETS } from "../settings.js";
import { MIN_BILLED_AUDIO_SEC } from "./limits.js";

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
  constructor({ router, settings, now = () => Date.now(), maxParallelStt = 2, quran = null, usage = null } = {}) {
    super();
    this.usage = usage; // UsageTracker | null
    this.quran = quran; // QuranIndex | null: restores exact verse text when recitation is recognised
    this.quranNext = null;
    this.quranMisses = 0;
    this.router = router;
    this.settings = settings;
    this.now = now;
    this.cfg = DELAY_PRESETS[settings.delay] || DELAY_PRESETS.balanced;
    this.glossary = new Glossary(settings.customGlossary || []);
    this.userTerms = (settings.customGlossary || []).map((e) => e.ar.split("|")[0].trim()).filter(Boolean);
    this.system = buildSystemPrompt({ termStyle: settings.termStyle, honorifics: settings.honorifics, dialect: settings.dialect });
    this.entries = [];
    this.audio = new Map(); // entry id -> wav (kept until the speech is transcribed)
    this.seq = 0;
    this.arTail = ""; // last Arabic transcribed (prompt + de-duplication)
    this.langCheckState = {}; // per service: failures in a row, and when it may be tried again
    this.langCheckWarned = false;
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
      const aiPrompt = buildOpenAiPrompt({ userTerms: this.userTerms });
      // gpt-4o-transcribe reads its prompt as instructions and echoes it on quiet audio, so it never gets the Arabic primer
      const promptFor = (item) => (item.provider === "openai" && /transcribe/.test(item.model) ? aiPrompt : prompt);
      const call = (lang) => (item) => this.router.providers[item.provider].transcribe(wav, { model: item.model, language: lang, prompt: promptFor(item), signal: this.abort.signal });
      const secs = Math.max(0, e.t1 - e.t0);
      // gpt-4o-transcribe never says which language it heard, and with an interpreter in the room it sometimes writes English
      // speech in Arabic letters (or translates it), which then gets filed under the sheikh.  A cheap Whisper pass, run alongside
      // it, supplies the language label the rules below need.
      const first = typeof this.router.chain === "function" ? this.router.chain("stt")[0] : null;
      const check = !language && this.settings.languageCheck !== false && first && first.provider === "openai" && /transcribe/.test(first.model) ? this._langCheck(wav, secs) : null;
      let { value: res, item: used } = await this.router.run("stt", call(language), { signal: this.abort.signal });
      this._recordUsage(used, secs);
      if (!language) {
        let whisper = null; // Whisper's own reading of this chunk, when the language check ran
        if (check && !res.language) {
          whisper = await check;
          if (whisper && whisper.language) res = { ...res, language: whisper.language };
        }
        const said = langCode(res.language);
        const script = scriptLang(res.text);
        let again = null;
        if (ARABIC_LOOKALIKES.has(said) && script === "ar") again = "ar"; // Arabic speech labelled Persian/Urdu: same script, wrong words
        else if (said === "ar" && script === "en") again = "ar"; // it "translated" instead of transcribing
        else if (said === "en" && script === "ar") {
          // English speech written out (or translated) in Arabic letters: Whisper already has the English, so use that
          if (whisper && this._englishFits(whisper.res.text, res.text)) res = { ...whisper.res, language: "english" };
          else again = "en";
        }
        else if (script === "en" && !looksLikeEnglish(res.text) && (said !== "en" || knownTermShare(res.text) < 0.7)) again = "ar"; // Arabic recitation written in Latin letters ("Tabbat yada abin habin…").  When the recogniser plainly says English and the words are known names and terms, it is the interpreter ("Sulayman alayhis salam")
        if (again) {
          // for English, drop the Arabic primer so it cannot pull the output back into Arabic script
          const retry = (item) => this.router.providers[item.provider].transcribe(wav, { model: item.model, language: again, prompt: again === "en" ? "" : promptFor(item), signal: this.abort.signal });
          const again2 = await this.router.run("stt", retry, { signal: this.abort.signal });
          this._recordUsage(again2.item, secs);
          // a wrong guess about the language must never replace good text with a translation or transliteration of it
          const redo = (again2.value.text || "").trim();
          const sane = again === "en" ? this._englishFits(redo, res.text) : scriptLang(redo) === "ar";
          if (sane || !res.text.trim()) res = again2.value;
        }
      }
      return res;
    } finally {
      this._release();
    }
  }

  /**
   * Is `english` plausibly what was said in the same chunk that came back as `arabic` text?  (Guards against a wrong "English"
   * label turning real Arabic recitation into a transliteration: a different number of words, or a long run of transliterated
   * Arabic, means it is not the same speech.)
   */
  _englishFits(english, arabic) {
    const t = (english || "").trim();
    if (!t || scriptLang(t) !== "en" || NOISE_ENGLISH.test(t)) return false;
    const gw = englishWords(t).length;
    const aw = (arabic || "").split(/\s+/).filter(Boolean).length;
    if (aw && (gw < aw * 0.5 || gw > aw * 4)) return false;
    return gw <= 4 || !looksTransliterated(t);
  }

  /**
   * Whisper's reading of a chunk - its language label and its own text - or null.  gpt-4o-transcribe says nothing about the language it
   * heard, and with an interpreter in the room it sometimes writes English in Arabic letters; this is the second opinion.  Tries the
   * cheap Groq turbo model first, then OpenAI's whisper-1, so a rate-limited free Groq key cannot switch it off.  Never throws.
   */
  async _langCheck(wav, secs) {
    const { providers, dead, models } = this.router;
    const candidates = [];
    if (providers.groq && !dead.has("groq")) {
      const list = (models && models.groq && models.groq.stt) || [];
      candidates.push({ provider: "groq", model: list.find((m) => /turbo/.test(m)) || list[0] || "whisper-large-v3-turbo" });
    }
    if (providers.openai && !dead.has("openai")) candidates.push({ provider: "openai", model: "whisper-1" });
    for (const c of candidates) {
      const st = (this.langCheckState[c.provider] ||= { fails: 0, offUntil: 0 });
      if (st.offUntil > this.now()) continue;
      try {
        const r = await providers[c.provider].transcribe(wav, { model: c.model, signal: this.abort.signal });
        this._recordUsage({ provider: c.provider, id: `${c.provider}:${c.model}` }, secs);
        st.fails = 0;
        this.langCheckWarned = false;
        return { language: langCode(r.language), res: r };
      } catch {
        if (this.stopped) return null;
        if (++st.fails >= 3) {
          st.offUntil = this.now() + 5 * 60000; // rest this one for a few minutes instead of failing every chunk
          st.fails = 0;
        }
      }
    }
    if (candidates.length && candidates.every((c) => (this.langCheckState[c.provider] || {}).offUntil > this.now()) && !this.langCheckWarned) {
      this.langCheckWarned = true;
      this.emit("notice", { level: "warn", info: true, code: "langcheck", text: "The language check isn't responding, so the interpreter may be mixed in with the sheikh for a while." });
    }
    return null;
  }

  _sttFailed(e, err) {
    const ae = ApiError.from(err);
    if (ae.kind === "aborted" || this.stopped) return this._drop(e);
    if (ae.kind === "auth") {
      e.state = "error"; // keep the audio; resume() re-queues it once the key is fixed
      e.error = ae.credit ? "Waiting for credit — add some, then tap Retry" : "Waiting for a working API key";
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
    let text = cleanTranscript(res, guess === "ar" ? this.arTail : "");
    text = stripPrimerEcho(text, { allowOpening: e.t0 < 120 }); // the recogniser reading its own hint back
    // One chunk can hold the end of the sheikh and the start of the interpreter (or the other way round):
    // give each language its own entry instead of one label for the lot.
    const labelledEnglish = langCode(res.language) === "en";
    const runs = splitByLanguage(text).filter((r) => {
      const lang = scriptLang(r.text);
      // not a phantom phrase, nor Arabic spelled in Latin letters; a piece the recogniser labelled English may be mostly names and
      // terms ("Sulayman alayhis salam", "Allah subhanahu wa ta'ala") and is kept unless it is a long run of transliteration
      if (lang === "en") return !NOISE_ENGLISH.test(r.text.trim()) && (looksLikeEnglish(r.text) || (labelledEnglish && knownTermShare(r.text) >= 0.7));
      return lang === "ar";
    });
    if (!runs.length) return this._drop(e);

    const total = runs.reduce((n, r) => n + r.text.length, 0) || 1;
    const span = Math.max(0, e.t1 - e.t0);
    let t = e.t0;
    let at = this.entries.indexOf(e);
    runs.forEach((run, i) => {
      let ent = e;
      const t1 = i === runs.length - 1 ? e.t1 : t + (span * run.text.length) / total;
      if (i > 0) {
        ent = { id: uid("e"), seq: e.seq + i / 100, t0: t, t1, kind: "lecture", ar: "", en: "", state: "transcribing", attempts: 0 };
        this.entries.splice(++at, 0, ent);
      } else ent.t1 = t1;
      this._commitRun(ent, run);
      t = t1;
    });
    this._pump();
  }

  /** If this piece starts a new sentence and the one before it (same speaker) was left without its full stop, add the stop. */
  _closeSentenceBefore(e) {
    const i = this.entries.indexOf(e);
    for (let j = i - 1; j >= 0; j--) {
      const p = this.entries[j];
      if (p.state === "transcribing" || (p.state === "error" && !p.en && !p.ar)) continue; // speaker not known yet: look past it
      if (p.kind === e.kind && p.state === "done" && p.en && needsStop(p.en, e.en)) {
        p.en = p.en.replace(/\s+$/, "") + ".";
        this.emit("entry", p);
      }
      return;
    }
  }

  /** Fill one entry with one run of speech: Arabic (the sheikh, to be translated) or English (the interpreter). */
  _commitRun(e, run) {
    let text = run.text;
    if (scriptLang(text) === "en") {
      e.kind = "interpreter";
      e.en = englishizeFormulae(text, this.settings.honorifics); // "صلى الله عليه وسلم" said in English speech -> ﷺ
      e.state = "done";
      this._closeSentenceBefore(e);
      // everything the sheikh said before the interpreter began no longer needs to wait for look-ahead
      for (const x of this.entries) if (x.seq < e.seq && x.state === "awaiting") x.forceReady = true;
      this.emit("entry", e);
    } else {
      e.kind = "lecture";
      if (this.quran) {
        const q = this.quran.annotate(text, this.quranNext);
        if (q) {
          text = q.text; // the exact verse words, with diacritics
          e.quran = q.refs;
          this.quranNext = q.next;
          this.quranMisses = 0;
        } else if (++this.quranMisses > 1) this.quranNext = null; // keep the place across one unmatched chunk
      }
      e.ar = text;
      e.state = "awaiting";
      e.sttDoneAt = this.now();
      this.arTail = lastWords((this.arTail + " " + text.replace(/[﴾﴿]/g, "")).trim(), 40);
      this.emit("entry", e);
    }
  }

  /** Count a finished request against the model's free allowance. */
  _recordUsage(item, audioSec = 0) {
    if (!this.usage) return;
    const prov = this.router.providers[item.provider] || {};
    const billed = item.provider === "groq" && audioSec ? Math.max(MIN_BILLED_AUDIO_SEC, audioSec) : audioSec;
    this.usage.record(item.id, { audio: billed, tokens: (prov.lastUsage && prov.lastUsage.tokens) || 0 });
    if (prov.lastReported) this.usage.setReported(item.id, prov.lastReported);
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
    // catch-up: if the translator has fallen behind (rate limit, slow network), translate several waiting slices as one request
    for (let guard = 0; guard < 2; guard++) {
      const nx = this.entries[idx + 1];
      if (!nx || nx.state !== "awaiting" || nx.kind !== "lecture" || nx.breakBefore) break;
      if (this.entries.slice(idx + 1).filter((x) => x.state === "awaiting").length < 2) break;
      e.ar = `${e.ar} ${nx.ar}`.trim();
      e.t1 = nx.t1;
      if (nx.quran) e.quran = [...(e.quran || []), ...nx.quran];
      this.entries.splice(idx + 1, 1);
      this.emit("remove", nx);
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
        55
      );
      const glossary = this.glossary.find([prevLecture?.ar, e.ar, nextAr].filter(Boolean).join(" "), 10);
      const user = buildUserPrompt({ current: e.ar, previous: prevLecture?.ar || "", next: nextAr, recent, glossary, context: this.settings.context || "", quran: e.quran || [] });
      const { value, item } = await this.router.run(
        "llm",
        (it) => this.router.providers[it.provider].chat({ model: it.model, system: this.system, user, signal: this.abort.signal }),
        { signal: this.abort.signal }
      );
      this._recordUsage(item);
      let en = cleanTranslation(value);
      if (looksTransliterated(en)) {
        // the model wrote Arabic in Latin letters instead of translating: insist once, then give up
        const again = await this.router.run(
          "llm",
          (it) => this.router.providers[it.provider].chat({ model: it.model, system: this.system, user: user + "\n\nIMPORTANT: your previous answer was a transliteration. Write the English MEANING of CURRENT in ordinary English words. Transliterate nothing except single terms such as salah or taqwa.", signal: this.abort.signal }),
          { signal: this.abort.signal }
        );
        this._recordUsage(again.item);
        en = cleanTranslation(again.value);
        if (looksTransliterated(en)) throw new ApiError("The translator gave a transliteration instead of a translation", { kind: "unknown" });
      }
      if (!en) throw new ApiError("The translator returned nothing", { kind: "unknown" });
      e.en = en;
      e.model = item.id;
      e.state = "done";
      this._closeSentenceBefore(e);
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
      .map(({ id, seq, t0, t1, kind, ar, en, state, breakBefore, quran }) => ({ id, seq, t0, t1, kind, ar, en, state: state === "done" ? "done" : "partial", ...(breakBefore ? { breakBefore } : {}), ...(quran ? { quran } : {}) }));
  }
}
