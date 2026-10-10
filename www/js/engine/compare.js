// "Speech test": run the SAME recording through each available speech engine so you can see whether a poor
// result comes from the app's audio, from one particular engine, or from the vocabulary hint.
import { ApiError } from "./errors.js";
import { buildWhisperPrompt } from "./glossary.js";
import { buildSystemPrompt, buildUserPrompt, cleanTranslation } from "./prompts.js";
import { MIN_BILLED_AUDIO_SEC } from "./limits.js";

const NICE = { gemini: "Gemini" };

/** The engines worth comparing with the keys that are set: Whisper large-v3, its turbo variant, Gemini. */
export function sttCandidates(router) {
  const out = [];
  const live = (p) => router.providers[p] && !router.dead.has(p);
  if (live("groq")) {
    const stt = router.models.groq.stt;
    const large = stt.find((m) => !/turbo/.test(m));
    const turbo = stt.find((m) => /turbo/.test(m));
    if (large) {
      out.push({ key: "large", provider: "groq", model: large, label: "Whisper large-v3", hint: true });
      out.push({ key: "large-nohint", provider: "groq", model: large, label: "Whisper large-v3 · no vocabulary hint", hint: false });
    }
    if (turbo) out.push({ key: "turbo", provider: "groq", model: turbo, label: "Whisper large-v3 turbo", hint: true });
  }
  if (live("openai")) {
    for (const model of router.models.openai.stt.slice(0, 2)) out.push({ key: `openai:${model}`, provider: "openai", model, label: `OpenAI · ${model}`, hint: true });
  }
  if (live("gemini") && router.models.gemini.stt.length) {
    const model = router.models.gemini.stt[0];
    out.push({ key: "gemini", provider: "gemini", model, label: `${NICE.gemini} · ${model.replace(/^gemini-/, "")}`, hint: true });
  }
  return out;
}

/**
 * @param {object} o
 * @param {import("./router.js").Router} o.router
 * @param {Blob} o.wav               the recording (16 kHz mono WAV, exactly what the app sends)
 * @param {number} o.seconds         its length
 * @param {object} o.settings        app settings (language choice, glossary, translation style…)
 * @param {object} [o.usage]         UsageTracker: the test counts against the free allowance like anything else
 * @param {(row:object)=>void} [o.onRow]  called when a row changes (so the screen can fill in as results arrive)
 * @param {AbortSignal} [o.signal]
 * @param {() => number} [o.now]
 * @returns {Promise<object[]>} one row per engine: { key, label, model, ms, text, language, en, error }
 */
export async function compareEngines({ router, wav, seconds, settings, usage = null, onRow = () => {}, signal, now = () => performance.now() }) {
  const userTerms = (settings.customGlossary || []).map((e) => e.ar.split("|")[0].trim()).filter(Boolean);
  const primer = buildWhisperPrompt({ userTerms });
  const language = settings.lectureLang === "ar" ? "ar" : undefined;
  const system = buildSystemPrompt({ termStyle: settings.termStyle, honorifics: settings.honorifics, dialect: settings.dialect });
  const rows = sttCandidates(router).map((c) => ({ ...c, state: "waiting", ms: 0, text: "", language: "", en: "", error: "" }));
  rows.forEach(onRow);

  const record = (provider, id, audio) => {
    if (!usage) return;
    const prov = router.providers[provider] || {};
    usage.record(id, { audio: provider === "groq" ? Math.max(MIN_BILLED_AUDIO_SEC, audio) : audio, tokens: (prov.lastUsage && prov.lastUsage.tokens) || 0 });
    if (prov.lastReported) usage.setReported(id, prov.lastReported);
  };

  // one at a time: each engine's timing is its own, and usage numbers cannot get mixed up between calls
  for (const row of rows) {
    if (signal && signal.aborted) break;
    row.state = "speech";
    onRow(row);
    const t0 = now();
    try {
      const res = await router.providers[row.provider].transcribe(wav, { model: row.model, language, prompt: row.hint ? primer : "", signal });
      row.ms = Math.round(now() - t0);
      row.text = (res.text || "").trim();
      row.language = res.language || "";
      record(row.provider, `${row.provider}:${row.model}`, seconds);
    } catch (err) {
      const e = ApiError.from(err, row.provider);
      if (e.kind === "aborted") break;
      row.ms = Math.round(now() - t0);
      row.error = e.message || "Failed";
    }
    row.state = "translating";
    onRow(row);
  }

  // translate each distinct transcript once with the engine chosen for translation, so you can judge the end result too
  const english = new Map();
  for (const row of rows) {
    if (signal && signal.aborted) break;
    if (!row.text) { row.state = "done"; onRow(row); continue; }
    if (!english.has(row.text)) {
      try {
        const user = buildUserPrompt({ current: row.text, context: settings.context || "" });
        const { value, item } = await router.run("llm", (it) => router.providers[it.provider].chat({ model: it.model, system, user, signal }), { signal, maxWaitMs: 20000 });
        record(item.provider, item.id, 0);
        english.set(row.text, cleanTranslation(value));
      } catch (err) {
        const e = ApiError.from(err);
        if (e.kind === "aborted") break;
        english.set(row.text, "");
        row.error = row.error || `Translation failed: ${e.message}`;
      }
    }
    row.en = english.get(row.text) || "";
    row.state = "done";
    onRow(row);
  }
  return rows;
}

const SHORT = { groq: "Groq", gemini: "Gemini", openai: "OpenAI" };

/** The best translation model of each service you have a key for. */
export function translatorCandidates(router) {
  const out = [];
  for (const provider of ["groq", "gemini", "openai"]) {
    if (!router.providers[provider] || router.dead.has(provider)) continue;
    const model = router.models[provider].llm[0];
    if (model) out.push({ key: `tr:${provider}`, provider, model, label: `${SHORT[provider]} · ${model.replace(/^openai\//, "").replace(/^gemini-/, "")}` });
  }
  return out;
}

/** The same Arabic text through each service's translator, side by side. */
export async function compareTranslators({ router, text, settings, usage = null, onRow = () => {}, signal, now = () => performance.now() }) {
  const system = buildSystemPrompt({ termStyle: settings.termStyle, honorifics: settings.honorifics, dialect: settings.dialect });
  const user = buildUserPrompt({ current: text, context: settings.context || "" });
  const rows = translatorCandidates(router).map((c) => ({ ...c, state: "waiting", ms: 0, en: "", error: "" }));
  rows.forEach(onRow);
  for (const row of rows) {
    if (signal && signal.aborted) break;
    row.state = "translating";
    onRow(row);
    const t0 = now();
    try {
      const out = await router.providers[row.provider].chat({ model: row.model, system, user, signal });
      row.ms = Math.round(now() - t0);
      row.en = cleanTranslation(out);
      if (usage) {
        const prov = router.providers[row.provider];
        usage.record(`${row.provider}:${row.model}`, { tokens: (prov.lastUsage && prov.lastUsage.tokens) || 0 });
      }
    } catch (err) {
      const e = ApiError.from(err, row.provider);
      if (e.kind === "aborted") break;
      row.ms = Math.round(now() - t0);
      row.error = e.message || "Failed";
    }
    row.state = "done";
    onRow(row);
  }
  return rows;
}
