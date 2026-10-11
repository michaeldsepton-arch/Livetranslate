// Turning the flat list of entries into readable paragraphs, and into the downloadable .txt.
import { fmtClock, fmtDate, fmtDuration, fileStamp, slugify, wordCount } from "../util.js";

// One block per speaker turn: the interpreter's block runs on until the sheikh speaks (and the other way round).  A pause or the
// size of the text never cuts a turn in two, because the speaker has not changed.  The only exceptions are a recording pause/resume
// or a lost microphone (e.breakBefore), and, so that a very long uninterrupted talk is still readable, a very long turn is
// paragraphed at the end of a sentence.
const LONG_TURN_WORDS = 600; // soft: break here, but only where a sentence ends
const HUGE_TURN_WORDS = 1200; // hard
const LONG_PAUSE_S = 90; // a silence this long, after a finished sentence, is a new paragraph
const SENTENCE_END = /[.!?…:"”’)\]]\s*$/;

/** A chunk still being transcribed has no speaker yet; it must not cut the paragraph around it in two. */
const pending = (e) => !e.ar && !e.en && (e.state === "transcribing" || e.state === "error");

/**
 * Group consecutive entries of the same speaker into flowing paragraphs.
 * @returns {{key:string, kind:string, t0:number, entries:object[]}[]}
 */
export function groupEntries(entries) {
  const groups = [];
  let g = null;
  let last = null; // the latest entry with text in the open group
  for (const e of entries) {
    if (pending(e) && g && !e.breakBefore) {
      g.entries.push(e); // shown as a placeholder inside the current turn until we know whose words it holds
      continue;
    }
    const words = wordCount(e.en || e.ar);
    const ended = !last || SENTENCE_END.test((last.en || last.ar || "").trim());
    const startNew =
      !g ||
      g.kind !== e.kind ||
      e.breakBefore ||
      (e.t0 - g.t1 > LONG_PAUSE_S && ended) ||
      (g.words + words > LONG_TURN_WORDS && ended) ||
      g.words + words > HUGE_TURN_WORDS;
    if (startNew) {
      g = { key: `${e.kind}:${e.id}`, kind: e.kind, t0: e.t0, t1: e.t1, entries: [], words: 0 };
      groups.push(g);
    }
    g.entries.push(e);
    g.t1 = Math.max(g.t1, e.t1);
    g.words += words;
    last = e;
  }
  return groups;
}

/** Qur'an references of a paragraph, merged: Al-Masad 111:1 + 111:2–5 -> "Al-Masad 111:1–5". */
export function mergeRefs(refs) {
  const out = [];
  for (const r of refs || []) {
    const prev = out[out.length - 1];
    const can = prev && r.surah && prev.surah === r.surah && r.to >= r.from && prev.to >= prev.from && r.from <= prev.to + 1 && r.to >= prev.from;
    if (can) {
      prev.from = Math.min(prev.from, r.from);
      prev.to = Math.max(prev.to, r.to);
    } else if (!out.some((o) => o.label === r.label && !o.surah)) out.push({ ...r });
  }
  return out.map((r) => (r.surah ? `${r.name} ${r.surah}:${r.from === r.to ? r.from : `${r.from}–${r.to}`}` : r.label));
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/** Where in a piece of English its Qur'an reference goes: right after the closing quotation mark (else at the end of that piece). */
export function refPlacement(en) {
  const i = Math.max(en.lastIndexOf('"'), en.lastIndexOf("”"));
  return i >= 0 ? i + 1 : en.length;
}

/** One piece of English with its Qur'an reference beside the quotation, not above the whole turn: …worship Me." (Qur'an Adh-Dhariyat 51:56) and then… */
export function inlineRef(e) {
  const en = clean(e.en);
  const refs = mergeRefs(e.quran || []);
  if (!en || !refs.length) return en;
  const at = refPlacement(en);
  return `${en.slice(0, at)} (Qur'an ${refs.join("; ")})${en.slice(at)}`;
}

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
      const en = g.entries.map(inlineRef).filter(Boolean).join(" ");
      const ar = g.entries.map((e) => clean(e.ar)).filter(Boolean).join(" ");
      lines.push(`${stamp}SHEIKH`);
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
