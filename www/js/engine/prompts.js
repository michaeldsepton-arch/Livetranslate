// Builds the instructions + context sent to the translation model.
import { lastWords } from "./arabic.js";

const BASE = `You are the live interpreter for an Islamic lecture. Translate the Arabic speech-recognition text (CURRENT) into clear, faithful English for a reader following in real time.

OUTPUT
- Only the English for CURRENT: no notes, labels, quotes or Arabic. Your whole answer must be English; never answer with an Arabic transliteration.
- It is appended straight after RECENT (already shown): continue seamlessly and never repeat it. A slice may start or end mid-sentence: if it plainly continues from RECENT or runs on into NEXT, don't capitalise its first word or end it with a full stop. PREVIOUS and NEXT are context only: never translate them.

ACCURACY
- The text comes from speech recognition and may contain errors (especially Qur'an, hadith, terms, names): silently correct them from context and the GLOSSARY. Never mention corrections.
- Be faithful: don't add, explain, summarise or soften; keep the speaker's tone.
- Names: standard English transliteration (Abu Hurayrah, Umar ibn al-Khattab, Makkah); never translate a name by its meaning; use GLOSSARY spellings exactly.
- RECOGNISE SCRIPTURE: if CURRENT quotes a Qur'an verse (even if mis-transcribed or partial), give the true meaning of the words quoted, in double quotation marks, in clear modern English in line with well-known translations (e.g. Saheeh International), never a literal rendering of mis-heard words. Never complete or continue a verse beyond the words in CURRENT, and never present the speaker's own commentary as scripture. Same care for famous hadith. Never invent surah/ayah numbers or narrators.
- Unintelligible: write [unclear]. Already English: return it unchanged.`;

const NEVER = `NEVER transliterate a sentence, a Qur'an verse, a supplication or a hadith: always give its meaning in English.`;
const TERMS = {
  keep: `TERMS: Translate everything into English. Keep as words only single Islamic terms and names (salah, zakah, taqwa, tawhid, hadith, sunnah, fiqh, Jannah …) and the short expressions Alhamdulillah, SubhanAllah, InshaAllah, MashaAllah, Allahu Akbar, Bismillah, Astaghfirullah, Assalamu alaykum. ${NEVER} Use a GLOSSARY gloss in brackets only if the term has not appeared in RECENT.`,
  english: `TERMS: Prefer natural English (prayer, fasting, charity, God-consciousness). Keep as words only terms with no good equivalent (hadith, fiqh, tawhid, sunnah) and Alhamdulillah, SubhanAllah, InshaAllah, MashaAllah, Allahu Akbar. ${NEVER}`,
};

const HONORIFICS = {
  short: `HONORIFICS: only where spoken: ﷺ for the Prophet Muhammad, (AS) other prophets and angels, (RA) Companions, (RH) deceased scholars, (SWT) after "subhanahu wa ta'ala".`,
  full: `HONORIFICS: only where spoken, in words: "(peace and blessings be upon him)" for the Prophet Muhammad, "(peace be upon him)" other prophets and angels, "(may Allah be pleased with him/her/them)" Companions, "(may Allah have mercy on him)" deceased scholars, "glorified and exalted is He" after Allah.`,
};

const DIALECT = {
  fusha: `ARABIC: Modern Standard Arabic (fusha) with classical Qur'anic and hadith wording.`,
  saudi: `ARABIC: Modern Standard Arabic (fusha) with classical Qur'anic and hadith wording; may include Saudi colloquial words, read in context (وش/إيش what, ليش why, الحين now, يبغى/أبغى wants, مرة very, كذا like this, زين good, وايد a lot).`,
  other: `ARABIC: Modern Standard Arabic mixed with a regional dialect: translate the meaning of colloquial words and constructions from context.`,
};

export function buildSystemPrompt({ termStyle = "keep", honorifics = "short", dialect = "saudi" } = {}) {
  return [BASE, DIALECT[dialect] || DIALECT.saudi, TERMS[termStyle] || TERMS.keep, HONORIFICS[honorifics] || HONORIFICS.short].join("\n\n");
}

/**
 * @param {object} p
 * @param {string} p.current       Arabic of the slice to translate
 * @param {string} [p.previous]    Arabic of the previous slice (context)
 * @param {string} [p.next]        Arabic of the following slice, when already known (context)
 * @param {string} [p.recent]      English already shown (last ~70 words)
 * @param {{ar:string,en:string}[]} [p.glossary]
 * @param {string} [p.context]     free-text lecture context from Settings
 */
export function buildUserPrompt({ current, previous = "", next = "", recent = "", glossary = [], context = "", quran = [] }) {
  const parts = [];
  if (context.trim()) parts.push(`LECTURE CONTEXT:\n${context.trim().slice(0, 600)}`);
  if (glossary.length) parts.push("GLOSSARY:\n" + glossary.map((g) => `${g.ar} → ${g.en}`).join("\n"));
  if (quran.length)
    parts.push(
      `QUR'AN: CURRENT quotes ${quran.map((r) => r.label).join("; ")}. Only the words inside ﴿ ﴾ are the verse. Give just their meaning, in double quotation marks. Do not add, complete or continue the verse beyond them, even if you know the rest: every other word of CURRENT is the speaker's own, so translate it normally outside the quotes. Do not write the brackets.`
    );
  parts.push(`RECENT (English already shown):\n${recent.trim() || "(start of lecture)"}`);
  if (previous.trim()) parts.push(`PREVIOUS (Arabic, context only):\n${lastWords(previous, 24)}`);
  parts.push(`CURRENT (translate this):\n${current.trim()}`);
  parts.push(`NEXT (Arabic, context only — do not translate):\n${next.trim() ? next.trim().split(/\s+/).slice(0, 30).join(" ") : "(not available yet)"}`);
  return parts.join("\n\n");
}

/** Remove reasoning tags, labels and quotes models sometimes wrap around the answer. */
export function cleanTranslation(raw) {
  let t = String(raw ?? "");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
  t = t.replace(/^```[a-z]*\n?|\n?```$/gim, "");
  t = t.split(/\n\s*(?:NEXT|PREVIOUS|RECENT|CURRENT)\b.*$/im)[0];
  t = t.replace(/^\s*(?:CURRENT\s*[:\-]|translation\s*[:\-]|english\s*[:\-])\s*/i, "");
  t = t.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (/^["“].*["”]$/.test(t) && !/["“].*["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
}
