// App settings: defaults, delay presets, persistence (localStorage, always wrapped in try/catch).

export const DEFAULT_SETTINGS = {
  groqKey: "",
  geminiKey: "",
  openaiKey: "", // pay-as-you-go; optional
  preferGemini: false, // legacy: kept so older saved settings still work
  sttEngine: "auto", // auto | groq | groq-turbo | gemini | openai   (speech recognition)
  llmEngine: "auto", // auto | groq | gemini | openai            (translation)
  context: "", // "Shaykh X — Seerah series. Names: …"
  delay: "balanced", // quick | balanced | smooth
  termStyle: "keep", // keep | english
  honorifics: "short", // short | full
  dialect: "saudi", // fusha | saudi | other
  backgroundListening: true, // keep listening with the screen off / another app in front
  groqPaid: true, // accounts are assumed to be on paid plans (no free-tier rationing, pacing or warnings); switch off for a free key
  geminiPaid: true,
  paidDefault: 1, // settings version: older saved settings are switched to the paid defaults once
  quranMatching: true, // recognise recited Qur'an verses and restore the exact text
  lectureLang: "auto", // auto (Arabic + English interpreter) | ar (Arabic only)
  showArabic: false,
  textSize: 1,
  theme: "dark", // dark | light
  noiseSuppression: true,
  autoGain: true,
  sensitivity: 0, // dB offset for the speech detector
  autoSave: true,
  saveArabic: true,
  saveTimestamps: true,
  customGlossary: [], // [{ar, en}]
  modelStt: "", // advanced overrides
  modelLlm: "",
  modelGemini: "",
  modelOpenai: "", // translation model override for OpenAI (e.g. gpt-5-mini)
};

/** How "smooth vs quick" maps onto chunking + how long we wait for the following sentence. */
export const DELAY_PRESETS = {
  instant: { label: "Instant", approx: "≈ 3–4 s behind", minChunkMs: 1500, maxChunkMs: 3200, endSilenceMs: 260, lookaheadWaitMs: 0, parallel: 3 },
  quick: { label: "Quick", approx: "≈ 6 s behind", minChunkMs: 3000, maxChunkMs: 7000, endSilenceMs: 450, lookaheadWaitMs: 0 },
  balanced: { label: "Balanced", approx: "≈ 10 s behind", minChunkMs: 3500, maxChunkMs: 9000, endSilenceMs: 600, lookaheadWaitMs: 4500 },
  smooth: { label: "Smooth", approx: "≈ 15 s behind", minChunkMs: 4000, maxChunkMs: 11000, endSilenceMs: 700, lookaheadWaitMs: 9000 },
};

const KEY = "lt.settings.v1";

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // older versions had one "use Gemini first" switch for both stages
      if (saved.paidDefault !== 1) {
        saved.groqPaid = true;
        saved.geminiPaid = true;
        saved.paidDefault = 1;
      }
      if (saved.preferGemini && saved.sttEngine === undefined && saved.llmEngine === undefined) saved.sttEngine = saved.llmEngine = "gemini", saved.preferGemini = false;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s, storage = globalThis.localStorage) {
  try {
    storage && storage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
