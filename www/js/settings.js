// App settings: defaults, delay presets, persistence (localStorage, always wrapped in try/catch).

export const DEFAULT_SETTINGS = {
  groqKey: "",
  geminiKey: "",
  preferGemini: false,
  context: "", // "Shaykh X — Seerah series. Names: …"
  delay: "balanced", // quick | balanced | smooth
  termStyle: "keep", // keep | english
  honorifics: "short", // short | full
  dialect: "saudi", // fusha | saudi | other
  backgroundListening: true, // keep listening with the screen off / another app in front
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
};

/** How "smooth vs quick" maps onto chunking + how long we wait for the following sentence. */
export const DELAY_PRESETS = {
  quick: { label: "Quick", approx: "≈ 6 s behind", minChunkMs: 3000, maxChunkMs: 7000, endSilenceMs: 450, lookaheadWaitMs: 0 },
  balanced: { label: "Balanced", approx: "≈ 10 s behind", minChunkMs: 3500, maxChunkMs: 9000, endSilenceMs: 600, lookaheadWaitMs: 4500 },
  smooth: { label: "Smooth", approx: "≈ 15 s behind", minChunkMs: 4000, maxChunkMs: 11000, endSilenceMs: 700, lookaheadWaitMs: 9000 },
};

const KEY = "lt.settings.v1";

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
