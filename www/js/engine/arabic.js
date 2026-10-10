// Arabic text helpers: normalisation for matching, script detection, language names.

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

/** Strip vowel marks, unify letter variants, drop punctuation -> good for matching. */
export function normalizeArabic(s) {
  return (s || "")
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^ء-غف-ي\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AR = /\p{Script=Arabic}/u;
const LAT = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

export function scriptCounts(s) {
  let ar = 0, lat = 0, other = 0;
  for (const ch of s || "") {
    if (!LETTER.test(ch)) continue;
    if (AR.test(ch)) ar++;
    else if (LAT.test(ch)) lat++;
    else other++;
  }
  return { ar, lat, other, total: ar + lat + other };
}

/** 'ar' | 'en' | 'other' | 'none' based purely on the letters in the text. */
export function scriptLang(s) {
  const { ar, lat, other, total } = scriptCounts(s);
  if (total < 2) return "none";
  if (other / total > 0.5) return "other";
  return ar >= lat ? "ar" : "en";
}

const LANG_NAMES = {
  arabic: "ar", english: "en", persian: "fa", farsi: "fa", urdu: "ur", pashto: "ps", kurdish: "ku",
  hebrew: "he", turkish: "tr", hindi: "hi", sindhi: "sd", uyghur: "ug", malay: "ms", indonesian: "id",
  french: "fr", spanish: "es", german: "de", russian: "ru", bengali: "bn", somali: "so", swahili: "sw",
};

/** Whisper reports full names ("arabic"); Gemini/others may give ISO codes. */
export function langCode(name) {
  if (!name) return "";
  const n = String(name).trim().toLowerCase();
  if (LANG_NAMES[n]) return LANG_NAMES[n];
  if (/^[a-z]{2,3}(-[a-z]+)?$/.test(n)) return n.slice(0, 2);
  return n;
}

/** Languages Whisper often mistakes Arabic speech for (same script). */
export const ARABIC_LOOKALIKES = new Set(["fa", "ur", "ps", "ku", "sd", "ug", "he", "tr"]);

export function lastWords(text, n) {
  const w = (text || "").trim().split(/\s+/).filter(Boolean);
  return w.slice(-n).join(" ");
}

export function firstWords(text, n) {
  const w = (text || "").trim().split(/\s+/).filter(Boolean);
  return w.slice(0, n).join(" ");
}
