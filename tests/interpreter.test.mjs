// Problems found in a real 54-minute recording (Arabic lecture + English interpreter, recognised by OpenAI).
import test from "node:test";
import assert from "node:assert/strict";
import { LectureEngine } from "../www/js/engine/session-engine.js";
import { Router } from "../www/js/engine/router.js";
import { DEFAULT_SETTINGS } from "../www/js/settings.js";
import { splitByLanguage, englishizeFormulae } from "../www/js/engine/english.js";
import { stripPrimerEcho } from "../www/js/engine/hallucination.js";
import { buildOpenAiPrompt } from "../www/js/engine/glossary.js";
import { groupEntries } from "../www/js/engine/transcript.js";
import { fakeProvider, fakeRouter, until } from "./helpers.mjs";

const chunk = (n = 0, at = 0) => ({ pcm: new Float32Array(1600), startMs: (at || n * 5) * 1000, endMs: ((at || n * 5) + 4.5) * 1000, voicedMs: 4000 });
const settled = (engine) => until(() => !engine._busy());
function setup({ stt, chat = () => "Translated.", settings = {}, router = null }) {
  const provider = fakeProvider({ transcribe: stt, chat });
  const engine = new LectureEngine({ router: router ? router(provider) : fakeRouter(provider), settings: { ...DEFAULT_SETTINGS, ...settings } });
  engine.cfg = { ...engine.cfg, lookaheadWaitMs: 0 };
  return { engine, provider };
}
const say = (text) => async () => ({ text, language: "", segments: [] }); // gpt-4o-transcribe: no language label

test("a chunk with the end of the sheikh and the start of the interpreter is split into two entries", () => {
  assert.deepEqual(splitByLanguage("جرير بن عبد الله رضي الله عنه، he mentioned that").map((r) => r.lang), ["ar", "en"]);
  assert.deepEqual(splitByLanguage("hardships merely smiling when you meet your brothers. ولا تدابروا ولا تباغضوا يا إخوة").map((r) => r.lang), ["en", "ar"]);
  assert.deepEqual(splitByLanguage("Praise be to Allah. ثم قال لهم الشيخ كلاما طويلا عن الصبر. and then he said that patience is key").map((r) => r.lang), ["en", "ar", "en"]);
});

test("short islands stay with the speaker: honorifics inside English, one English word inside Arabic, transliterated terms", () => {
  for (const [text, lang] of [
    ["الله سبحانه وتعالى is kind", "en"],
    ["حديث regarding an example of a good companion", "en"],
    ["Allah سبحانه وتعالى will hide away his own faults", "en"],
    ["الحمد لله، الله سبحانه وتعالى will rectify them", "en"],
    ["عليه السلام did not cease to advise me regarding the neighbor", "en"],
    ["حتى لو كان لديك مشاكل، حتى لو كان لديك hardships", "ar"],
    ["هذا نص عربي فقط بدون أي إنجليزي هنا", "ar"],
    ["thank you, SubhanAllah, Alhamdulillah", "en"],
  ]) {
    const runs = splitByLanguage(text);
    assert.equal(runs.length, 1, text);
    assert.equal(runs[0].lang, lang, text);
    assert.equal(runs[0].text, text);
  }
  assert.deepEqual(splitByLanguage(""), []);
});

test("Arabic set phrases in the interpreter's English become English forms, in the chosen honorific style", () => {
  assert.equal(englishizeFormulae("The Messenger صلى الله عليه وسلم said: the best of you"), "The Messenger ﷺ said: the best of you");
  assert.equal(englishizeFormulae("Allah سبحانه وتعالى will hide his faults"), "Allah (SWT) will hide his faults");
  assert.equal(englishizeFormulae("عليه السلام did not cease to advise me"), "(AS) did not cease to advise me");
  assert.equal(englishizeFormulae("حديث regarding an example"), "Hadith regarding an example");
  assert.equal(englishizeFormulae("إن شاء الله، الله is kind"), "InshaAllah, Allah is kind");
  assert.equal(englishizeFormulae("الحمد لله، Allah will rectify"), "Alhamdulillah, Allah will rectify");
  assert.equal(englishizeFormulae("The Messenger صلى الله عليه وسلم said", "full"), "The Messenger (peace and blessings be upon him) said");
  assert.equal(englishizeFormulae("Plain English stays exactly as it is."), "Plain English stays exactly as it is.");
  assert.equal(englishizeFormulae("Arabic تشوفون words"), "Arabic you see words");
});

test("the recogniser reading its own hint back is removed, but real speech that resembles it is kept", () => {
  const OPEN = "بسم الله الرحمن الرحيم. الحمد لله رب العالمين، والصلاة والسلام على رسول الله صلى الله عليه وسلم.";
  const real = "نقف عند هذا القدر. على عبده ورسوله محمد وعلى آله وأصحابه أجمعين.";
  assert.equal(stripPrimerEcho(`${real} ${OPEN}`), real, "appended after quiet audio");
  assert.equal(stripPrimerEcho(`${real} ${OPEN}`, { allowOpening: true }), `${real} ${OPEN}`, "a lecture really does open this way");
  assert.equal(stripPrimerEcho("توحيد، العقيدة، الفقه، الحديث، السيرة، الصحابة،"), "", "the list of subjects");
  const hadith = "قال رسول الله صلى الله عليه وسلم لا تحاسدوا ولا تناجشوا ثم قال رسول الله صلى الله عليه وسلم";
  assert.equal(stripPrimerEcho(hadith), hadith);
  assert.equal(stripPrimerEcho("بسم الله الرحمن الرحيم."), "بسم الله الرحمن الرحيم.", "a lone basmala may be real");
  assert.equal(stripPrimerEcho("وكان الحديث عن السيرة والصحابة والفقه في هذا الباب"), "وكان الحديث عن السيرة والصحابة والفقه في هذا الباب");
});

test("engine: a mixed chunk becomes a sheikh entry plus an interpreter entry; only the Arabic is translated", async () => {
  const { engine, provider } = setup({ stt: say("جرير بن عبد الله رضي الله عنه، he mentioned that") });
  engine.ingestChunk(chunk(0, 100));
  await settled(engine);
  const [a, b] = engine.entries;
  assert.deepEqual([a.kind, b.kind], ["lecture", "interpreter"]);
  assert.match(a.ar, /جرير بن عبد الله/);
  assert.equal(a.en, "Translated.");
  assert.equal(b.en, "he mentioned that");
  assert.ok(!/he mentioned/.test(a.ar), "the interpreter's words are not left in the Arabic line");
  assert.equal(provider.calls.chat.length, 1);
  assert.ok(!provider.calls.chat[0].user.includes("he mentioned"), "and are not sent to be translated");
  assert.ok(a.t0 < b.t0 && b.t1 <= 104.5 + 1e-6 && a.t1 <= b.t0 + 1e-6, "times are shared out in order across the chunk");
  assert.ok(a.seq < b.seq);
});

test("engine: interpreter text has its Arabic honorifics turned into English forms", async () => {
  const { engine } = setup({ stt: say("The Messenger صلى الله عليه وسلم said that Allah سبحانه وتعالى loves kindness.") });
  engine.ingestChunk(chunk(0, 100));
  await settled(engine);
  assert.equal(engine.entries[0].kind, "interpreter");
  assert.equal(engine.entries[0].en, "The Messenger ﷺ said that Allah (SWT) loves kindness.");
});

test("engine: a primer read-back at the end of a chunk is dropped, but kept in the first two minutes", async () => {
  const OPEN = "بسم الله الرحمن الرحيم. الحمد لله رب العالمين، والصلاة والسلام على رسول الله صلى الله عليه وسلم.";
  const { engine } = setup({ stt: say(`نقف عند هذا القدر وإياكم ممن يستمع القول. ${OPEN}`) });
  engine.ingestChunk(chunk(0, 1000));
  engine.ingestChunk(chunk(1, 10));
  await settled(engine);
  const late = engine.entries.find((e) => e.t0 === 1000);
  const early = engine.entries.find((e) => e.t0 === 10);
  assert.ok(!late.ar.includes("الحمد لله رب العالمين"));
  assert.ok(early.ar.includes("الحمد لله رب العالمين"));
});

test("engine: a chunk that is only the subjects list is dropped as a phantom", async () => {
  const { engine } = setup({ stt: say("توحيد، العقيدة، الفقه، الحديث، السيرة، الصحابة،") });
  engine.ingestChunk(chunk(0, 500));
  await settled(engine);
  assert.equal(engine.entries.length, 0);
});

test("gpt-4o-transcribe gets a short English prompt; Whisper keeps the Arabic primer", async () => {
  const mkRouter = (provider) => {
    const r = new Router({ openai: provider, groq: provider }, { engines: { stt: "openai" }, sleep: async () => {} });
    r.models.openai = { stt: ["gpt-4o-transcribe", "whisper-1"], llm: ["gpt-4.1"] };
    r.models.groq = { stt: ["whisper-large-v3"], llm: ["x"] };
    return r;
  };
  const { engine, provider } = setup({ stt: say("بسم الله الرحمن الرحيم الحمد لله"), router: mkRouter, settings: { customGlossary: [{ ar: "ابن تيمية", en: "Ibn Taymiyyah" }] } });
  engine.ingestChunk(chunk(0, 300));
  await settled(engine);
  const sent = provider.calls.transcribe.find((c) => c.model === "gpt-4o-transcribe");
  assert.ok(sent, "gpt-4o-transcribe was used");
  assert.equal(sent.prompt, buildOpenAiPrompt({ userTerms: ["ابن تيمية"] }));
  assert.match(sent.prompt, /ابن تيمية/);
  assert.ok(!sent.prompt.includes("الحمد لله رب العالمين"), "no Arabic primer to echo");
  assert.ok(sent.prompt.length < 400, "still short");
  // the prompt itself, read back on silence, is recognised as a phantom
  const echo = setup({ stt: say(buildOpenAiPrompt({})), router: mkRouter });
  echo.engine.ingestChunk(chunk(0, 300));
  await settled(echo.engine);
  assert.equal(echo.engine.entries.length, 0);
});

test("paragraphs: an unfinished sentence is not cut by a pause between chunks, a finished one is", () => {
  const E = (id, t0, t1, en) => ({ id, seq: +id, t0, t1, kind: "interpreter", ar: "", en, state: "done" });
  const mid = [E("1", 362, 364, "Some of what the brotherhood necessitates and doing good to others includes"), E("2", 376, 390, "guiding them and helping them.")];
  assert.equal(groupEntries(mid).length, 1, "12 s pause, but the sentence had not ended");
  const done = [E("1", 362, 364, "Some of what the brotherhood necessitates includes this."), E("2", 376, 390, "Guiding them and helping them.")];
  assert.equal(groupEntries(done).length, 2, "a finished sentence followed by a pause starts a new paragraph");
  const longPause = [E("1", 362, 364, "It was unfinished and"), E("2", 400, 404, "this is something else.")];
  assert.equal(groupEntries(longPause).length, 2, "but not forever");
});

import { buildUserPrompt, buildSystemPrompt } from "../www/js/engine/prompts.js";

test("the translator is told exactly which words are the verse and not to complete it", () => {
  const user = buildUserPrompt({ current: "آية وإن كثيرا من الناس عن البر", quran: [{ label: "Yunus 10:92", words: "ءَايَةٗۚ وَإِنَّ كَثِيرٗا مِّنَ ٱلنَّاسِ" }] });
  assert.match(user, /Only these words are the verse: «ءَايَةٗۚ وَإِنَّ كَثِيرٗا مِّنَ ٱلنَّاسِ»/);
  assert.match(user, /Do not add, complete or continue the verse/);
  assert.match(user, /every other word of CURRENT is the speaker's own/);
  assert.match(buildSystemPrompt(), /Never complete or continue a verse beyond the words in CURRENT/);
});

// ---- English speech written in Arabic letters, caught by a language label from a cheap Whisper pass ----
function twoServices({ openai, groq, settings = {} }) {
  const o = fakeProvider({ name: "openai", transcribe: openai, chat: () => "Translated." });
  const g = fakeProvider({ name: "groq", transcribe: groq, chat: () => "Translated." });
  const router = new Router({ openai: o, groq: g }, { sleep: async () => {} });
  router.models.openai = { stt: ["gpt-4o-transcribe", "whisper-1"], llm: ["gpt-4.1"] };
  router.models.groq = { stt: ["whisper-large-v3", "whisper-large-v3-turbo"], llm: ["x"] };
  const engine = new LectureEngine({ router, settings: { ...DEFAULT_SETTINGS, ...settings } });
  engine.cfg = { ...engine.cfg, lookaheadWaitMs: 0 };
  return { engine, o, g };
}

test("interpreter English that gpt-4o wrote in Arabic letters is re-read as English and shown as the interpreter", async () => {
  const { engine, o, g } = twoServices({
    // the mistake seen in a real recording: "how can anyone" came back as an Arabic translation
    openai: (_w, opts) => ({ text: opts.language === "en" ? "How can anyone be arrogant" : "كيف يمكن لأي شخص", language: "", segments: [] }),
    groq: () => ({ text: "How can anyone be arrogant", language: "english", segments: [] }),
  });
  engine.ingestChunk(chunk(0, 300));
  await settled(engine);
  assert.equal(engine.entries.length, 1);
  assert.equal(engine.entries[0].kind, "interpreter");
  assert.equal(engine.entries[0].en, "How can anyone be arrogant");
  assert.equal(o.calls.chat.length + g.calls.chat.length, 0, "never translated");
  assert.ok(g.calls.transcribe[0].model.includes("turbo"), "the language check uses the cheap turbo model");
  assert.equal(g.calls.transcribe[0].prompt, undefined, "and no primer, so there is nothing for it to echo");
  assert.deepEqual(o.calls.transcribe.map((c) => c.language), [undefined, "en"], "second read is told it is English");
});

test("real Arabic is untouched by the language check", async () => {
  const { engine, o } = twoServices({
    openai: () => ({ text: "الكبر من أمراض القلوب الخطيرة", language: "", segments: [] }),
    groq: () => ({ text: "الكبر من أمراض القلوب", language: "arabic", segments: [] }),
  });
  engine.ingestChunk(chunk(0, 300));
  await settled(engine);
  assert.equal(engine.entries[0].kind, "lecture");
  assert.equal(engine.entries[0].ar, "الكبر من أمراض القلوب الخطيرة");
  assert.equal(o.calls.transcribe.length, 1, "one read, no re-run");
});

test("a wrong 'English' label never replaces real Arabic with a transliteration", async () => {
  const { engine } = twoServices({
    openai: (_w, opts) => ({ text: opts.language === "en" ? "Tabbat yada abi lahabin wa tabb" : "تبت يدا أبي لهب وتب", language: "", segments: [] }),
    groq: () => ({ text: "Tabbat yada", language: "english", segments: [] }),
  });
  engine.ingestChunk(chunk(0, 300));
  await settled(engine);
  assert.equal(engine.entries[0].kind, "lecture");
  assert.equal(engine.entries[0].ar, "تبت يدا أبي لهب وتب");
});

test("language check failing or switched off: lectures carry on exactly as before", async () => {
  let calls = 0;
  const SENTENCES = ["الكبر من أمراض القلوب الخطيرة جدا", "والمتواضع هو المحسن إلى الناس", "لا يدخل الجنة من كان في قلبه كبر", "العلم يورث الخشية والتواضع", "أقرب ما يكون العبد من ربه وهو ساجد"];
  const failing = twoServices({ openai: (_w, _o, n) => ({ text: SENTENCES[(n - 1) % 5], language: "", segments: [] }), groq: () => { calls++; throw new Error("down"); } });
  for (let i = 0; i < 5; i++) { failing.engine.ingestChunk(chunk(i, 300 + i * 10)); await settled(failing.engine); }
  assert.equal(failing.engine.entries.filter((e) => e.kind === "lecture").length, 5, "every chunk still transcribed");
  assert.equal(calls, 3, "after three failures the check rests for a few minutes instead of stalling every chunk");

  const off = twoServices({ openai: () => ({ text: "الكبر من أمراض القلوب الخطيرة جدا", language: "", segments: [] }), groq: () => ({ text: "x", language: "english", segments: [] }), settings: { languageCheck: false } });
  off.engine.ingestChunk(chunk(0, 300));
  await settled(off.engine);
  assert.equal(off.g.calls.transcribe.length, 0);

  const arabicOnly = twoServices({ openai: () => ({ text: "الكبر من أمراض القلوب الخطيرة جدا", language: "", segments: [] }), groq: () => ({ text: "x", language: "english", segments: [] }), settings: { lectureLang: "ar" } });
  arabicOnly.engine.ingestChunk(chunk(0, 300));
  await settled(arabicOnly.engine);
  assert.equal(arabicOnly.g.calls.transcribe.length, 0, "Arabic-only mode needs no check");
});

test("with only OpenAI, whisper-1 gives the label; engines that already label their output need no check", async () => {
  const o = fakeProvider({ name: "openai", transcribe: (_w, opts) => (opts.model === "whisper-1" ? { text: "hello there", language: "english", segments: [] } : { text: opts.language === "en" ? "Hello there everyone" : "مرحبا بكم جميعا", language: "", segments: [] }), chat: () => "T." });
  const router = new Router({ openai: o }, { sleep: async () => {} });
  router.models.openai = { stt: ["gpt-4o-transcribe", "whisper-1"], llm: ["gpt-4.1"] };
  const engine = new LectureEngine({ router, settings: { ...DEFAULT_SETTINGS } });
  engine.cfg = { ...engine.cfg, lookaheadWaitMs: 0 };
  engine.ingestChunk(chunk(0, 300));
  await settled(engine);
  assert.equal(engine.entries[0].kind, "interpreter");
  assert.equal(engine.entries[0].en, "Hello there everyone");
  assert.ok(o.calls.transcribe.some((c) => c.model === "whisper-1"));

  const groqOnly = setup({ stt: say("الكبر من أمراض القلوب الخطيرة جدا") });
  groqOnly.engine.ingestChunk(chunk(0, 300));
  await settled(groqOnly.engine);
  assert.equal(groqOnly.provider.calls.transcribe.length, 1, "no extra call for a service that is not label-less");
});
