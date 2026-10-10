// Typical FREE-tier limits, used to draw the usage bars and to pace requests politely.
// They are estimates: Groq/Google change them, and the account page is the final word
// (the app links to it).  Where a service reports real numbers in its response headers we use those instead.

/** Groq bills at least this many audio seconds per request, however short the clip. */
export const MIN_BILLED_AUDIO_SEC = 10;

const TABLE = [
  { re: /^groq:whisper-/, role: "Speech", limits: { rpm: 20, rpd: 2000, ash: 7200, asd: 28800 } },
  { re: /^groq:openai\/gpt-oss/, role: "Translation", limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 } },
  { re: /^groq:/, role: "Translation", limits: { rpm: 30 } },
  // Gemini free limits vary by model and account (see Google AI Studio). Only a cautious per-minute pace is assumed,
  // so requests spread across Gemini models instead of tripping the cap; no usage bars are drawn for it.
  { re: /^gemini:.*flash-lite/, role: "Gemini", limits: { rpm: 15 } },
  { re: /^gemini:/, role: "Gemini", limits: { rpm: 10 } },
  { re: /^openai:/, role: "OpenAI", limits: {} }, // pay-as-you-go: no free allowance to ration
];

export function limitsFor(id) {
  const m = TABLE.find((x) => x.re.test(id));
  return m ? m.limits : {};
}

export function roleOf(id) {
  const m = TABLE.find((x) => x.re.test(id));
  return m ? m.role : "";
}

export function providerOf(id) {
  return String(id).split(":")[0];
}

export function modelOf(id) {
  return String(id).slice(String(id).indexOf(":") + 1);
}

export function prettyModel(id) {
  const model = modelOf(id).replace(/^openai\//, "").replace(/^whisper-large-v3-turbo$/, "Whisper large-v3 turbo").replace(/^whisper-large-v3$/, "Whisper large-v3");
  return model;
}

export const PROVIDER_LABEL = { groq: "Groq", gemini: "Google Gemini", openai: "OpenAI" };

// Rough OpenAI prices (USD) so the app can show about what a lecture has cost.  Estimates only: the OpenAI billing page is exact.
const OPENAI_PER_AUDIO_MIN = [[/mini-transcribe/, 0.003], [/transcribe|whisper/, 0.006]];
// per 1M tokens, blended for roughly 95% input / 5% output (what translation prompts look like)
const OPENAI_PER_M_TOKENS = [[/^gpt-4\.1-mini/, 0.46], [/^gpt-4\.1/, 2.3], [/^gpt-4o-mini/, 0.17], [/^gpt-4o/, 2.9], [/^gpt-5(\.\d+)?-mini/, 0.34], [/^gpt-5/, 1.7]];

export function openaiCost(id, { audioSec = 0, tokens = 0 } = {}) {
  const model = modelOf(id);
  const min = OPENAI_PER_AUDIO_MIN.find(([re]) => re.test(model));
  if (min) return (audioSec / 60) * min[1];
  const tok = OPENAI_PER_M_TOKENS.find(([re]) => re.test(model));
  return (tokens / 1e6) * (tok ? tok[1] : 3);
}
