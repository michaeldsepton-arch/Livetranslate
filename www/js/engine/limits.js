// Typical FREE-tier limits, used to draw the usage bars and to pace requests politely.
// They are estimates: Groq/Google change them, and the account page is the final word
// (the app links to it).  Where a service reports real numbers in its response headers we use those instead.

/** Groq bills at least this many audio seconds per request, however short the clip. */
export const MIN_BILLED_AUDIO_SEC = 10;

const TABLE = [
  { re: /^groq:whisper-/, role: "Speech", limits: { rpm: 20, rpd: 2000, ash: 7200, asd: 28800 } },
  { re: /^groq:openai\/gpt-oss/, role: "Translation", limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 } },
  { re: /^groq:/, role: "Translation", limits: { rpm: 30 } },
  { re: /^gemini:/, role: "Gemini", limits: {} }, // varies by model and account: see Google AI Studio
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

export const PROVIDER_LABEL = { groq: "Groq", gemini: "Google Gemini" };
