// Recognises Qur'an recitation in the speech-to-text output and restores the exact verse text.
//
// Recitation is hard for speech recognisers (melody, tajweed, archaic words), so a single wrong letter
// ("ماله" heard as "معنه") makes any translation nonsense.  The Qur'an is a fixed text, so we match
// the transcript against it (a word-level fuzzy alignment) and swap the matched stretch for the true
// verse words.  The translator is then told it is translating the Qur'an, so it gives the real meaning.
//
// Arabic text: Uthmani script from The Noble Qur'an Encyclopedia via quran-json (CC BY-SA 4.0), see
// www/data/LICENSE-quran-data.txt.
import { normalizeArabic } from "./arabic.js";

const MIN_INLIERS = 4; // matched words needed before we trust a match
const MAX_BUCKET = 80; // ignore 3-word phrases that occur more than this many times (too generic)

// Little words that start and end half the sentences in the language.  A match may not begin or end on one of them: a stray
// "إن" or "عن" next to a quoted phrase is far more likely the speaker's own word than the next word of the verse.
const EDGE_WORDS = new Set(
  `و ف ب ل ك من في على علي عن الي الى ان إن أن ما لا لم لن قد ثم او أو بل اذا إذا هو هي هم انه إنه انها إنها هذا هذه ذلك كل كان يا`.split(/\s+/).map((w) => normalizeArabic(w) || w)
);
const isEdgeWord = (norm) => !norm || norm.length <= 2 || EDGE_WORDS.has(norm);

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Matching key: the consonant skeleton.  Uthmani spelling and modern spelling disagree about alifs and
 * hamzas (القرءان / القرآن, الإنسن / الإنسان), and speech recognisers add their own variants, so those
 * letters are ignored for matching.
 */
export function wordKey(w) {
  const n = normalizeArabic(w);
  const k = n.replace(/[اء]/g, "");
  return k || n;
}

/** Words are "the same" if identical, or close enough to be one mis-heard letter. */
function sameWord(a, b) {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 4) return false;
  const tol = len >= 8 ? 2 : 1;
  return editDistance(a, b, tol) <= tol;
}

export class QuranIndex {
  /** @param {{s:{n:string,a:string,v:string[]}[]}} data  see www/data/quran-ar.json */
  constructor(data) {
    this.surahs = data.s;
    this.display = []; // diacritised words (with any pause mark attached)
    this.norm = []; // matching form of each word
    this.verseOfWord = []; // global word index -> verse id
    this.verses = []; // {surah (1-based), ayah (1-based), start, end}
    this.surahRange = []; // [firstWord, endWord) per surah
    data.s.forEach((s, si) => {
      const sStart = this.display.length;
      s.v.forEach((text, ai) => {
        const start = this.display.length;
        for (const tok of text.split(/\s+/).filter(Boolean)) {
          const n = wordKey(tok);
          if (!normalizeArabic(tok)) {
            if (this.display.length > start) this.display[this.display.length - 1] += " " + tok; // stop sign etc.
            continue;
          }
          this.display.push(tok);
          this.norm.push(n);
          this.verseOfWord.push(this.verses.length);
        }
        this.verses.push({ surah: si + 1, ayah: ai + 1, start, end: this.display.length });
      });
      this.surahRange.push([sStart, this.display.length]);
    });
    this.shingles = new Map();
    for (let g = 0; g + 2 < this.norm.length; g++) {
      const key = `${this.norm[g]} ${this.norm[g + 1]} ${this.norm[g + 2]}`;
      const list = this.shingles.get(key);
      list ? list.push(g) : this.shingles.set(key, [g]);
    }
  }

  surahOfWord(g) {
    return this.verses[this.verseOfWord[g]].surah;
  }

  label(gFirst, gLast) {
    const a = this.verses[this.verseOfWord[gFirst]];
    const b = this.verses[this.verseOfWord[gLast]];
    const name = this.surahs[a.surah - 1].n;
    const range = a.surah === b.surah ? (a.ayah === b.ayah ? `${a.ayah}` : `${a.ayah}–${b.ayah}`) : `${a.ayah}–${b.surah}:${b.ayah}`;
    return { surah: a.surah, name, from: a.ayah, to: b.ayah, label: `${name} ${a.surah}:${range}` };
  }

  /**
   * Look for Qur'an in `text`.  Returns null, or {text, refs, next} where `text` has the matched stretch
   * replaced by the exact verse words and `next` is the global index of the word that should come next.
   * @param {string} text
   * @param {number|null} expected  global word index that continues the previous recitation (tie-breaker)
   */
  annotate(text, expected = null) {
    const toks = (text || "").split(/\s+/).filter(Boolean);
    const idx = [];
    const q = [];
    toks.forEach((t, i) => {
      const n = normalizeArabic(t) ? wordKey(t) : "";
      if (n) {
        idx.push(i);
        q.push(n);
      }
    });
    const m = q.length;
    if (m < MIN_INLIERS) return null;

    // 1. vote for "diagonals": which stretch of the Qur'an do the chunk's 3-word phrases point at?
    const votes = new Map();
    for (let i = 0; i + 2 < m; i++) {
      const hits = this.shingles.get(`${q[i]} ${q[i + 1]} ${q[i + 2]}`);
      if (!hits || hits.length > MAX_BUCKET) continue;
      for (const g of hits) votes.set(g - i, (votes.get(g - i) || 0) + 1);
    }
    if (!votes.size) return null;
    const cands = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    // 2. align the chunk against each candidate stretch (fuzzy), keep the best
    let best = null;
    const scored = [];
    for (const [d, v] of cands) {
      const al = this._align(q, d);
      if (!al) continue;
      const bonus = expected != null && Math.abs(al.gFirst - al.i0 - expected) <= 3 ? 0.15 : 0;
      const score = al.inliers / Math.max(m, 1) + bonus + v * 0.001;
      const c = { ...al, d, score, continued: bonus > 0 };
      scored.push(c);
      if (!best || score > best.score) best = c;
    }
    if (!best) return null;
    // A short phrase that occurs in many places (لا إله إلا الله, الحمد لله رب العالمين) cannot be pinned to one verse:
    // better to tag nothing than to tag the wrong surah, unless we know where the recitation had reached.
    const rivals = scored.filter((c) => c !== best && Math.abs(c.gFirst - best.gFirst) > 6 && c.inliers >= best.inliers - 1 && c.score > best.score - 0.05);
    if (rivals.length && !best.continued && best.inliers < 8) return null;
    const need = best.continued ? 3 : MIN_INLIERS;
    const density = best.inliers / (best.i1 - best.i0 + 1);
    if (best.inliers < need || density < (best.continued ? 0.5 : 0.6)) return null;

    // 3. the quotation may not begin or end on a little word ("... of the people عن" -> the speaker's own "عن البر")
    const chain = best.chain.slice();
    const word = (pair) => normalizeArabic(toks[idx[pair[0]]]);
    // (unless that little word really is where the verse begins or ends: "قل هو الله أحد", "…وما كسب")
    const startsVerse = (g) => this.verses[this.verseOfWord[g]].start === g;
    const endsVerse = (g) => this.verses[this.verseOfWord[g]].end - 1 === g;
    while (chain.length && isEdgeWord(word(chain[0])) && !startsVerse(chain[0][1])) chain.shift();
    while (chain.length && isEdgeWord(word(chain[chain.length - 1])) && !endsVerse(chain[chain.length - 1][1])) chain.pop();
    if (chain.length < need) return null;
    let i0 = chain[0][0], i1 = chain[chain.length - 1][0], g0 = chain[0][1], g1 = chain[chain.length - 1][1];
    const inliers = chain.length;

    // 4. in a chunk that is nearly all recitation, a couple of unmatched words at the very start/end are probably the same verse
    //    (cut-off or mis-heard); when the speaker is merely quoting a phrase inside his own talk they are his words, so leave them
    const [sLo, sHi] = this.surahRange[this.surahOfWord(g0) - 1];
    if (inliers / m >= 0.6) {
      if (i0 <= 2) { g0 = Math.max(sLo, g0 - i0); i0 = 0; }
      if (m - 1 - i1 <= 2) { g1 = Math.min(sHi - 1, g1 + (m - 1 - i1)); i1 = m - 1; }
    }

    // the Basmala on its own is a greeting, not worth tagging as "Al-Fatihah 1:1"
    if (g0 === 0 && g1 <= 3) return null;

    const canonical = this.display.slice(g0, g1 + 1).join(" ");
    const ref = { ...this.label(g0, g1), words: canonical }; // (the exact words, so the translator can be told where the verse stops)
    const before = toks.slice(0, idx[i0]);
    const after = toks.slice(idx[i1] + 1);
    // fenced with the Qur'anic brackets, so everything (the screen, the file, the translator) can tell the verse from the speaker's own words
    return { text: [...before, `﴿${canonical}﴾`, ...after].join(" "), refs: [ref], next: g1 + 1 < this.display.length ? g1 + 1 : null };
  }

  /** Fuzzy in-order alignment of chunk words q[] against the Qur'an words starting at global index d. */
  _align(q, d) {
    const m = q.length;
    const lo = Math.max(0, d - 3);
    const hi = Math.min(this.norm.length, d + m + 4);
    if (hi - lo < 3) return null;
    const win = this.norm.slice(lo, hi);
    const n = win.length;
    // longest common subsequence with fuzzy equality
    const dp = Array.from({ length: m + 1 }, () => new Int16Array(n + 1));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = sameWord(q[i - 1], win[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const pairs = [];
    for (let i = m, j = n; i > 0 && j > 0; ) {
      if (sameWord(q[i - 1], win[j - 1]) && dp[i][j] === dp[i - 1][j - 1] + 1) {
        pairs.push([i - 1, lo + j - 1]);
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    pairs.reverse();
    if (!pairs.length) return null;
    // keep only pairs that stay on (about) the same diagonal as the candidate...
    const inl = pairs.filter(([i, g]) => Math.abs(g - i - d) <= 3);
    if (!inl.length) return null;
    // ...and then only the densest unbroken chain of them (stray one-word matches elsewhere are noise)
    let best = [], cur = [inl[0]];
    for (let k = 1; k < inl.length; k++) {
      const a = cur[cur.length - 1], b = inl[k];
      if (b[0] - a[0] - 1 <= 2 && b[1] - a[1] - 1 <= 3) cur.push(b);
      else {
        if (cur.length > best.length) best = cur;
        cur = [b];
      }
    }
    if (cur.length > best.length) best = cur;
    return { inliers: best.length, i0: best[0][0], i1: best[best.length - 1][0], gFirst: best[0][1], gLast: best[best.length - 1][1], chain: best };
  }
}

/** Browser/app side: fetch + build once. */
let cached = null;
export async function loadQuran(url = "data/quran-ar.json") {
  if (!cached) {
    cached = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("quran data " + r.status);
        return r.json();
      })
      .then((data) => new QuranIndex(data))
      .catch(() => null); // the app works without it
  }
  return cached;
}
