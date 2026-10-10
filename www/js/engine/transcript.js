// Turning the flat list of entries into readable paragraphs, and into the downloadable .txt.
import { fmtClock, fmtDate, fmtDuration, fileStamp, slugify, wordCount } from "../util.js";

const GAP_BREAK_S = 3.5; // a pause this long starts a new paragraph
const MAX_ENTRIES = 6;
const MAX_WORDS = 85;

/**
 * Group consecutive entries of the same speaker into flowing paragraphs.
 * @returns {{key:string, kind:string, t0:number, entries:object[]}[]}
 */
export function groupEntries(entries) {
  const groups = [];
  let g = null;
  for (const e of entries) {
    const words = wordCount(e.en || e.ar);
    const startNew =
      !g ||
      g.kind !== e.kind ||
      e.t0 - g.t1 > GAP_BREAK_S ||
      g.entries.length >= MAX_ENTRIES ||
      g.words + words > MAX_WORDS ||
      e.breakBefore;
    if (startNew) {
      g = { key: "g" + e.id, kind: e.kind, t0: e.t0, t1: e.t1, entries: [], words: 0 };
      groups.push(g);
    }
    g.entries.push(e);
    g.t1 = Math.max(g.t1, e.t1);
    g.words += words;
  }
  return groups;
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/**
 * @param {object} session  {title, startedAt, durationSec, context, entries}
 * @param {{includeArabic?:boolean, timestamps?:boolean}} opts
 */
export function buildTxt(session, { includeArabic = true, timestamps = true } = {}) {
  const lines = [];
  lines.push("LISAN — LECTURE TRANSCRIPT");
  lines.push("=".repeat(44));
  lines.push(`Title:    ${session.title}`);
  lines.push(`Date:     ${fmtDate(session.startedAt)}`);
  lines.push(`Duration: ${fmtDuration(session.durationSec)}`);
  if (session.context) lines.push(`Context:  ${clean(session.context)}`);
  lines.push("Note:     Machine translation — names, verses and hadith should be checked against reliable sources.");
  lines.push("=".repeat(44));
  lines.push("");

  const done = (session.entries || []).filter((e) => e.en || e.ar);
  for (const g of groupEntries(done)) {
    const stamp = timestamps ? `[${fmtClock(g.t0)}] ` : "";
    if (g.kind === "interpreter") {
      lines.push(`${stamp}INTERPRETER`);
      lines.push(g.entries.map((e) => clean(e.en)).join(" "));
    } else {
      const en = g.entries.map((e) => clean(e.en)).filter(Boolean).join(" ");
      const ar = g.entries.map((e) => clean(e.ar)).filter(Boolean).join(" ");
      if (timestamps) lines.push(`[${fmtClock(g.t0)}]`);
      if (en) lines.push(en);
      else if (!includeArabic && ar) lines.push("(untranslated)");
      if (includeArabic && ar) lines.push("‏" + ar); // RLM so editors lay the Arabic line out right-to-left
    }
    lines.push("");
  }
  lines.push("— end of transcript —");
  return lines.join("\n") + "\n";
}

export function suggestTitle(startedAt) {
  return `Lecture — ${fmtDate(startedAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export function suggestFilename(session, ext = "txt") {
  const slug = slugify(session.title && !session.title.startsWith("Lecture —") ? session.title : "lecture");
  return `${slug || "lecture"}_${fileStamp(session.startedAt)}.${ext}`;
}
