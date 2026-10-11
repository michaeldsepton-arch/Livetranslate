// Speech recognisers invent text on silence / noise ("subscribe to the channel", "Subtitles by…").
// These filters remove those, collapse runaway repetition and strip text repeated from the prompt.
import { normalizeArabic } from "./arabic.js";
import { WHISPER_PRIMER } from "./glossary-data.js";

const KNOWN_AR = [
  "ترجمة نانسي قنقر", "ترجمه نانسي قنقر", "اشتركوا في القناة", "اشترك في القناة", "اشتركوا بالقناة",
  "لا تنسوا الاشتراك", "لا تنسى الاشتراك", "شكرا لمشاهدتكم", "شكرا على المشاهدة", "شكرا لكم على المشاهدة",
  "شكرا للمشاهدة", "ترجمة المجتمع", "الترجمة بواسطة", "تفعيل الجرس", "مترجم من", "تابعونا على",
  "اضغط على زر الاشتراك", "لا تنسوا الاشتراك في القناة",
].map(normalizeArabic);

const KNOWN_EN = [
  "thanks for watching", "thank you for watching", "please subscribe", "subtitles by", "amara org",
  "transcribed by", "like and subscribe", "see you in the next video", "subtitles made by",
  "translated by", "captions by", "www ", "copyright ",
];

const plainEn = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** True when the text is (essentially) one of the well-known phantom outputs. */
export function isKnownHallucination(text) {
  const t = (text || "").trim();
  if (!t) return false;
  const plain = plainEn(t);
  if (plain.includes("islamic lecture") && plain.includes("interpreter")) return true; // the OpenAI prompt read back to us
  const words = t.split(/\s+/).length;
  if (words > 14) return false;
  const ar = normalizeArabic(t);
  if (ar && KNOWN_AR.some((k) => k && ar.includes(k))) return true;
  const en = plainEn(t);
  if (en && KNOWN_EN.some((k) => en.includes(k))) return true;
  return false;
}

// The recogniser is shown a short religious primer; on quiet audio it sometimes reads the primer back
// ("بسم الله الرحمن الرحيم. الحمد لله رب العالمين…" at the end of a chunk, or its list of subjects).
const primerTokens = normalizeArabic(WHISPER_PRIMER).split(/\s+/).filter(Boolean);
const PRIMER_OPENING = primerTokens.slice(0, primerTokens.indexOf(normalizeArabic("وسلم")) + 1); // basmala + hamdala + salawat: a real lecture opens with it too
const norm = (w) => normalizeArabic(w) || w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const strip = (w) => norm(w).replace(/^ال/, "");
const SUBJECTS = new Set(["توحيد", "عقيده", "فقه", "حديث", "سيره", "صحابه"].map((w) => strip(w)));

/**
 * Remove a read-back of the primer from a transcript.  The opening of a lecture (allowOpening) may genuinely
 * begin with the same words, so that is left alone.
 */
export function stripPrimerEcho(text, { allowOpening = false } = {}) {
  let tokens = (text || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  // the list of subjects (tawhid, aqidah, fiqh, hadith, seerah, the Companions): nobody says this
  for (let i = 0; i < tokens.length; ) {
    let j = i;
    while (j < tokens.length && SUBJECTS.has(strip(tokens[j]))) j++;
    if (j - i >= 4) tokens = [...tokens.slice(0, i), ...tokens.slice(j)];
    else i = Math.max(j, i + 1);
  }
  if (!allowOpening) {
    const keys = tokens.map(norm);
    const n = PRIMER_OPENING.length;
    const at = (from) => keys.slice(from, from + n).join(" ") === PRIMER_OPENING.join(" ");
    if (keys.length >= n && at(keys.length - n)) tokens = tokens.slice(0, keys.length - n); // appended to the end
    else if (keys.length >= n && at(0)) tokens = tokens.slice(n); // or prepended
    // what followed the basmala + hamdala in the primer may follow it here
    const rest = primerTokens.slice(n);
    for (let k = Math.min(rest.length, 8); k >= 3 && tokens.length; k--) {
      const key = tokens.map(norm);
      if (key.slice(-k).join(" ") === rest.slice(0, k).join(" ") && tokens.length > k + 2) {
        tokens = tokens.slice(0, tokens.length - k);
        break;
      }
    }
  }
  return tokens.join(" ").trim();
}

/** Drop low-confidence segments reported by Whisper-style verbose output. */
export function filterSegments(result) {
  const segs = result.segments;
  if (!Array.isArray(segs) || !segs.length) return (result.text || "").trim();
  const kept = segs.filter((s) => {
    const nsp = s.no_speech_prob ?? 0;
    const lp = s.avg_logprob ?? 0;
    const cr = s.compression_ratio ?? 1;
    if (nsp > 0.6 && lp < -0.7) return false;
    if (lp < -1.7) return false;
    if (cr > 2.8) return false;
    return (s.text || "").trim().length > 0;
  });
  return kept.map((s) => s.text.trim()).join(" ").trim();
}

/** "a b a b a b a b a b …" (10x) -> 3 repetitions.  Real dhikr counts stay readable. */
export function collapseRepeats(text, minRun = 8, keep = 3) {
  const tokens = (text || "").split(/\s+/).filter(Boolean);
  if (tokens.length < minRun) return text;
  const key = (t) => normalizeArabic(t) || t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const keys = tokens.map(key);
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let collapsed = false;
    for (let n = 1; n <= 6 && !collapsed; n++) {
      if (i + n * minRun > tokens.length) break;
      let runs = 1;
      while (i + (runs + 1) * n <= tokens.length && keys.slice(i, i + n).join("|") === keys.slice(i + runs * n, i + (runs + 1) * n).join("|")) runs++;
      if (runs >= minRun) {
        for (let r = 0; r < keep; r++) out.push(...tokens.slice(i, i + n));
        i += runs * n;
        collapsed = true;
      }
    }
    if (!collapsed) out.push(tokens[i++]);
  }
  return out.join(" ");
}

/**
 * The recogniser is primed with the previous text and sometimes echoes it.  Remove a repeated
 * prefix (>= 3 words) and discard text that is wholly contained in the previous tail.
 */
export function dedupeAgainst(prevTail, text) {
  const t = (text || "").trim();
  if (!t || !prevTail) return t;
  const prevN = normalizeArabic(prevTail) || prevTail.toLowerCase();
  const curN = normalizeArabic(t) || t.toLowerCase();
  if (curN.length >= 12 && prevN.includes(curN)) return "";
  const prevTokens = prevTail.trim().split(/\s+/);
  const curTokens = t.split(/\s+/);
  const k = (w) => normalizeArabic(w) || w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let n = Math.min(12, prevTokens.length, curTokens.length); n >= 3; n--) {
    const a = prevTokens.slice(-n).map(k).join(" ");
    const b = curTokens.slice(0, n).map(k).join(" ");
    if (a && a === b) return curTokens.slice(n).join(" ").trim();
  }
  return t;
}

/** Full cleaning pipeline for one transcription result -> final text ('' when nothing usable). */
export function cleanTranscript(result, prevTail = "") {
  let text = filterSegments(result);
  if (!text) return "";
  text = collapseRepeats(text);
  text = dedupeAgainst(prevTail, text);
  if (isKnownHallucination(text)) return "";
  return text.replace(/\s+/g, " ").trim();
}
