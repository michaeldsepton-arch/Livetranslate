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
