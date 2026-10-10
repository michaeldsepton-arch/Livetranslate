// Parses the glossary text, finds the entries relevant to a piece of Arabic, and builds the
// biasing prompt for the speech recogniser.
import { GLOSSARY_TEXT, WHISPER_PRIMER } from "./glossary-data.js";
import { normalizeArabic, lastWords } from "./arabic.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// optional و/ف, optional ب/ل/ك, optional ال/ل  (e.g. وبالصلاة, للصلاة, فالصلاة)
const PREFIX = "(?:(?:و|ف)?(?:ب|ل|ك)?(?:ال|ل)?)";
// possessive / plural endings that can attach to a noun
const SUFFIX = "(?:ها|هم|هما|كم|نا|ه|ك|ي|ن|ون|ين|ات|ا)?";

export function parseGlossary(text, { custom = false } = {}) {
  const out = [];
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const arPart = line.slice(0, i).trim();
    const en = line.slice(i + 1).trim();
    if (!arPart || !en) continue;
    const variants = arPart.split("|").map((v) => v.trim()).filter(Boolean);
    const norms = variants.map(normalizeArabic).filter((n) => n.length >= 2);
    if (!norms.length) continue;
    const regexes = norms.map((n) => {
      const words = n.split(" ");
      if (words[0].startsWith("ال") && words[0].length > 3) words[0] = words[0].slice(2);
      return new RegExp("(?:^|\\s)" + PREFIX + escapeRe(words.join(" ")) + SUFFIX + "(?=\\s|$)");
    });
    out.push({ ar: variants[0], en, norms, regexes, custom });
  }
  return out;
}

let BUILTIN = null;
export function builtinGlossary() {
  return (BUILTIN ||= parseGlossary(GLOSSARY_TEXT));
}

export class Glossary {
  /** @param {{ar:string,en:string}[]} userEntries  from Settings → My terms */
  constructor(userEntries = []) {
    const userText = userEntries.map((e) => `${e.ar} = ${e.en}`).join("\n");
    this.user = parseGlossary(userText, { custom: true });
    this.all = [...this.user, ...builtinGlossary()];
  }

  /** Entries whose Arabic appears in `text` (diacritics/prefix tolerant), most specific first. */
  find(text, limit = 16) {
    const hay = normalizeArabic(text);
    if (!hay) return [];
    const hits = [];
    for (const e of this.all) {
      if (e.regexes.some((r) => r.test(hay))) hits.push(e);
    }
    // drop entries wholly contained in a longer matched entry (e.g. "أبو بكر" inside "أبو بكر الصديق")
    const kept = hits.filter(
      (a) => !hits.some((b) => b !== a && b.norms[0].length > a.norms[0].length && b.norms[0].includes(a.norms[0]))
    );
    kept.sort((a, b) => Number(b.custom) - Number(a.custom) || b.norms[0].length - a.norms[0].length);
    return kept.slice(0, limit);
  }
}

/**
 * Build the (<= ~360 char) prompt given to Whisper: a religious-lecture primer, the user's own terms
 * and the tail of what was just transcribed (the most recent text matters most to the decoder).
 */
export function buildWhisperPrompt({ userTerms = [], tail = "", maxChars = 360 } = {}) {
  const tailPart = lastWords(tail, 22).slice(-170);
  let terms = "";
  for (const t of userTerms) {
    const next = terms ? terms + "، " + t : t;
    if (next.length > 110) break;
    terms = next;
  }
  const budget = Math.max(0, maxChars - tailPart.length - terms.length - 4);
  let primer = WHISPER_PRIMER.slice(0, budget);
  const cut = primer.lastIndexOf(" ");
  if (primer.length === budget && cut > 20) primer = primer.slice(0, cut);
  return [primer, terms, tailPart].filter(Boolean).join(" ").trim();
}
