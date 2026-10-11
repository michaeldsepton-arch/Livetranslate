// "Is this really English?"  Whisper sometimes labels Arabic recitation as English and writes it out in
// Latin letters ("Tabbat yada abin habin wa tabba").  Real English is full of small common words;
// transliterated Arabic has almost none.
const COMMON = new Set(`the a an and or but if of to in on at by for with from as is are was were be been being it its this that these those
i you he she we they me him her us them my your his our their what who whom how when where why which not no yes so do does did done have has had
will would can could should may might must shall there here now then than about all one two some any very just also up out into over more most
other thank thanks please hello hi okay ok good well said say says let going go get got like know think see want need come make take people time
because after before again always never today tonight tomorrow everyone everybody brothers sisters welcome sheikh shaykh allah prophet peace blessings
upon praise lord worlds speaking talking explained explaining mentioned means meaning about topic lecture tonight verse chapter surah`.split(/\s+/));

export function englishWords(text) {
  return (text.toLowerCase().match(/[a-z']+/g) || []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
}

/** Share of words that are common English words (0..1). */
export function englishScore(text) {
  const words = englishWords(text);
  if (!words.length) return 0;
  return words.filter((w) => COMMON.has(w)).length / words.length;
}

/** English sentence of a few words or more, as opposed to transliterated Arabic. */
export function looksLikeEnglish(text) {
  const words = englishWords(text);
  if (!words.length) return false;
  const score = englishScore(text);
  return words.length <= 2 ? score >= 0.5 : score >= 0.25;
}

// Short fixed expressions that are *meant* to stay transliterated (so a line of "SubhanAllah, SubhanAllah…" is fine).
const KEEP = new Set(`subhanallah subhan allah alhamdulillah allahu akbar inshaallah mashaallah bismillah astaghfirullah assalamu alaykum salah
zakah taqwa tawhid hadith sunnah fiqh jannah ameen amin`.split(/\s+/));

/**
 * True when a "translation" is really Arabic written in Latin letters (a whole sentence transliterated).
 * Needs a few words so a lone "Alhamdulillah." is never flagged.
 */
export function looksTransliterated(text) {
  const words = englishWords(text);
  if (words.length < 5) return false;
  const common = words.filter((w) => COMMON.has(w)).length / words.length;
  const kept = words.filter((w) => KEEP.has(w)).length / words.length;
  return common < 0.15 && kept < 0.4;
}

// ---- two speakers, two languages -------------------------------------------------------------------------
// The sheikh speaks Arabic and the interpreter English, but a chunk of audio can hold the end of one and the
// start of the other.  Instead of giving the whole chunk one label, split the text where the language changes.

const AR_LETTER = /[؀-ۿݐ-ݿ]/;
const LAT_LETTER = /[A-Za-z]/;
const DIACRITICS = /[ً-ٰٟـ]/g;

/** Arabic that is only honorifics / set phrases (an English speaker saying "sallallahu alayhi wasallam"). */
const FORMULA_WORDS = new Set(
  `الله سبحانه وتعالى تعالى صلى عليه وسلم وسلم عليه السلام رضي عنه عنها عنهم عنهما رحمه عز وجل جل جلاله الحمد لله رب العالمين ان شاء ما سبحان اكبر بسم الرحمن الرحيم حديث الحديث نعم`.split(/\s+/)
);
const plainAr = (w) => w.replace(DIACRITICS, "").replace(/[أإآ]/g, "ا").replace(/[\u060C\u061B\u061F\u066A-\u066D\u06D4]/g, "").replace(/[^\u0600-\u06FF]/g, "");

export function isFormulaOnly(text) {
  const words = text.split(/\s+/).map(plainAr).filter(Boolean);
  return words.length > 0 && words.every((w) => FORMULA_WORDS.has(w));
}

/**
 * @returns {{lang:"ar"|"en", text:string}[]}  in spoken order.  One entry for ordinary single-language text.
 * Short islands (an honorific inside English, a stray English word inside Arabic) stay with the surrounding speaker.
 */
export function splitByLanguage(text) {
  const tokens = (text || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const cls = (t) => (AR_LETTER.test(t) ? "ar" : LAT_LETTER.test(t) ? "en" : "x");
  // runs of one script; punctuation/digits stick to the run before them
  const runs = [];
  for (const t of tokens) {
    const c = cls(t);
    const last = runs[runs.length - 1];
    if (c === "x" && last) last.tokens.push(t);
    else if (last && last.lang === c) last.tokens.push(t);
    else runs.push({ lang: c === "x" ? "en" : c, tokens: [t], neutralStart: c === "x" });
  }
  const textOf = (r) => r.tokens.join(" ");
  const words = (r) => r.tokens.filter((t) => cls(t) !== "x").length;
  // a run is "strong" (a real turn of speech) when long enough and not just set phrases / transliterated terms
  const strong = (r) =>
    r.lang === "ar" ? words(r) >= 3 && !isFormulaOnly(textOf(r)) : words(r) >= 2 && looksLikeEnglish(textOf(r)) && !englishWords(textOf(r)).every((w) => KEEP.has(w));
  const flags = runs.map(strong);
  if (!flags.some(Boolean)) {
    // nothing clearly a turn: the language with more words wins and takes everything
    const ar = runs.filter((r) => r.lang === "ar").reduce((n, r) => n + words(r), 0);
    const en = runs.filter((r) => r.lang === "en").reduce((n, r) => n + words(r), 0);
    return [{ lang: ar >= en ? "ar" : "en", text: tokens.join(" ") }];
  }
  // weak runs join the strong run before them (or, at the very start, the one after)
  const out = [];
  let pending = [];
  runs.forEach((r, i) => {
    if (flags[i]) {
      const merged = { lang: r.lang, tokens: [...pending.flatMap((p) => p.tokens), ...r.tokens] };
      pending = [];
      const prev = out[out.length - 1];
      if (prev && prev.lang === merged.lang) prev.tokens.push(...merged.tokens);
      else out.push(merged);
    } else if (out.length) {
      out[out.length - 1].tokens.push(...r.tokens);
    } else pending.push(r);
  });
  return out.map((r) => ({ lang: r.lang, text: r.tokens.join(" ") }));
}

// Arabic set phrases an interpreter says in English speech, which a recogniser sometimes writes in Arabic letters.
const NOT_AR = "(?<![\\u0621-\\u064A\\u0671-\\u06D3])"; // (Arabic punctuation does not count as part of a word)
const NOT_AR_AFTER = "(?![\\u0621-\\u064A\\u0671-\\u06D3])";
const arRe = (src) => new RegExp(NOT_AR + src + NOT_AR_AFTER, "g");
const FORMULAE = [
  [arRe("صلى الله عليه (?:و ?اله )?وسلم"), "ﷺ", "(peace and blessings be upon him)"],
  [arRe("عليه(?:م|ا)? السلام"), "(AS)", "(peace be upon him)"],
  [arRe("رضي الله عنهم?ا?"), "(RA)", "(may Allah be pleased with him)"],
  [arRe("رضي الله عنها"), "(RA)", "(may Allah be pleased with her)"],
  [arRe("رحمه الله(?: تعالى)?"), "(RH)", "(may Allah have mercy on him)"],
  [arRe("سبحانه و ?تعالى"), "(SWT)", "(glorified and exalted is He)"],
  [arRe("(?:عز و ?جل|جل جلاله)"), "(SWT)", "(mighty and majestic is He)"],
  [arRe("الحمد لله رب العالمين"), "All praise is due to Allah, Lord of the worlds", null],
  [arRe("الحمد لله"), "Alhamdulillah", null],
  [arRe("(?:ا?ن|ا?نشاء) ?شاء الله"), "InshaAllah", null],
  [arRe("ما شاء الله"), "MashaAllah", null],
  [arRe("سبحان الله"), "SubhanAllah", null],
  [arRe("الله ا?كبر"), "Allahu Akbar", null],
  [arRe("بسم الله الرحمن الرحيم"), "In the name of Allah, the Most Gracious, the Most Merciful", null],
  [arRe("بسم الله"), "Bismillah", null],
  [arRe("ا?ستغفر الله"), "Astaghfirullah", null],
  [arRe("الله"), "Allah", null],
  [arRe("(?:ال)?حديث"), "hadith", null],
  [arRe("نعم"), "Yes", null],
  [arRe("تشوفون"), "you see", null],
];

/** Interpreter text in English letters: set phrases written in Arabic script become their English forms. */
export function englishizeFormulae(text, honorifics = "short") {
  if (!AR_LETTER.test(text || "")) return text;
  let t = text.replace(DIACRITICS, "").replace(/[أإآ]/g, "ا");
  for (const [re, short, full] of FORMULAE) t = t.replace(re, honorifics === "full" && full ? full : short);
  t = t.replace(/،/g, ",").replace(/؛/g, ";").replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return /^[a-z]/.test(t) && AR_LETTER.test((text || "").trim()[0]) ? t[0].toUpperCase() + t.slice(1) : t; // a phrase that opened the sentence
}
