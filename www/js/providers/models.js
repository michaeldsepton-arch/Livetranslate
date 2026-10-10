// Free-tier model lineups change often, so we ask each service what is currently available and
// pick from an ordered preference list.  Fallbacks mean one exhausted daily quota never stops a lecture
// (every model has its own allowance).

export const GROQ_STT_PREFERENCE = ["whisper-large-v3", "whisper-large-v3-turbo"];

export const GROQ_LLM_PREFERENCE = [
  "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct-0905",
  "moonshotai/kimi-k2-instruct",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.1-8b-instant",
];

const NOT_CHAT = /whisper|guard|tts|orpheus|playai|embed|safeguard|compound|distil|vision-preview/i;

export function pickGroqModels(available) {
  const have = new Set(available || []);
  const stt = GROQ_STT_PREFERENCE.filter((m) => !available || have.has(m));
  const llm = GROQ_LLM_PREFERENCE.filter((m) => !available || have.has(m)).slice(0, 4);
  if (available && !llm.length) llm.push(...available.filter((m) => !NOT_CHAT.test(m)).slice(0, 2));
  return {
    stt: stt.length ? stt : GROQ_STT_PREFERENCE.slice(0, 1),
    llm: llm.length ? llm : GROQ_LLM_PREFERENCE.slice(0, 2),
  };
}

export const OPENAI_STT_PREFERENCE = ["gpt-4o-transcribe", "whisper-1", "gpt-4o-mini-transcribe"];
// strong, fast, non-"thinking" models first: a live lecture cannot wait several seconds for a model to reason
export const OPENAI_LLM_PREFERENCE = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"];
const OPENAI_NOT_CHAT = /transcribe|whisper|tts|audio|realtime|image|search|embed|moderation|instruct|codex|preview|dall|sora/i;

export function pickOpenAiModels(available) {
  const have = new Set(available || []);
  const stt = OPENAI_STT_PREFERENCE.filter((m) => !available || have.has(m));
  const llm = OPENAI_LLM_PREFERENCE.filter((m) => !available || have.has(m)).slice(0, 3);
  if (available && !llm.length) llm.push(...available.filter((m) => /^gpt-/.test(m) && !OPENAI_NOT_CHAT.test(m)).slice(0, 2));
  return {
    stt: stt.length ? stt : OPENAI_STT_PREFERENCE.slice(0, 2),
    llm: llm.length ? llm : OPENAI_LLM_PREFERENCE.slice(0, 2),
  };
}

/** gemini-2.5-flash, gemini-3-flash, … (stable aliases only; newest first, flash before flash-lite). */
export function pickGeminiModels(available) {
  const fallback = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  if (!available) return { stt: fallback, llm: fallback };
  const cands = available
    .map((id) => {
      const m = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(id);
      return m ? { id, ver: parseFloat(m[1]), lite: !!m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ver - a.ver || Number(a.lite) - Number(b.lite));
  const ids = cands.map((c) => c.id).slice(0, 3);
  const list = ids.length ? ids : fallback;
  return { stt: list, llm: list };
}
