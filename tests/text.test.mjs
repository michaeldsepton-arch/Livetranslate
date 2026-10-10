import test from "node:test";
import assert from "node:assert/strict";
import { normalizeArabic, scriptLang, langCode } from "../www/js/engine/arabic.js";
import { Glossary, buildWhisperPrompt, builtinGlossary } from "../www/js/engine/glossary.js";
import { isKnownHallucination, collapseRepeats, dedupeAgainst, cleanTranscript, filterSegments } from "../www/js/engine/hallucination.js";
import { cleanTranslation, buildUserPrompt, buildSystemPrompt } from "../www/js/engine/prompts.js";

test("normalizeArabic strips diacritics and unifies letters", () => {
  assert.equal(normalizeArabic("الرَّحْمَٰنِ الرَّحِيمِ"), "الرحمن الرحيم");
  assert.equal(normalizeArabic("أبو هريرة، رضي الله عنه."), "ابو هريره رضي الله عنه");
});

test("scriptLang tells Arabic from English", () => {
  assert.equal(scriptLang("بسم الله الرحمن الرحيم"), "ar");
  assert.equal(scriptLang("Good evening everyone, welcome."), "en");
  assert.equal(scriptLang("قال النبي صلى الله عليه وسلم لأبي بكر Abu Bakr"), "ar"); // a Latin name inside Arabic stays Arabic
  assert.equal(scriptLang("The Sheikh said: بسم الله, and then continued in English for a while"), "en");
  assert.equal(scriptLang("12 34 !!"), "none");
  assert.equal(scriptLang("这是中文的句子"), "other");
});

test("langCode maps whisper language names", () => {
  assert.equal(langCode("arabic"), "ar");
  assert.equal(langCode("Persian"), "fa");
  assert.equal(langCode("en"), "en");
});

test("built-in glossary parses (hundreds of entries)", () => {
  assert.ok(builtinGlossary().length > 450, `only ${builtinGlossary().length}`);
});

test("glossary finds terms and names despite prefixes and diacritics", () => {
  const g = new Glossary();
  const hits = (t) => g.find(t).map((e) => e.en.split(" (")[0]);
  assert.ok(hits("وبالتوحيد نعرف الله").some((x) => x.startsWith("tawhid")));
  assert.ok(hits("قال أبو هريرة رضي الله عنه").includes("Abu Hurayrah"));
  assert.ok(hits("عن عمر بن الخطاب رضي الله عنه").includes("Umar ibn al-Khattab"));
  assert.ok(hits("تفسير الإمام ابن كثير").some((x) => /Ibn Kathir/.test(x)));
  assert.ok(hits("في سورة البقرة آية الكرسي").includes("Surah Al-Baqarah"));
  assert.ok(hits("نزل قوله تعالى في غزوة بدر").includes("Badr"));
});

test("glossary prefers the longer match and user terms first", () => {
  const g = new Glossary([{ ar: "الشيخ عبد الرحمن", en: "Shaykh Abd ar-Rahman" }]);
  const out = g.find("قال الشيخ عبد الرحمن عن أبو بكر الصديق");
  assert.equal(out[0].en, "Shaykh Abd ar-Rahman");
  const names = out.map((e) => e.en);
  assert.ok(names.includes("Abu Bakr as-Siddiq"));
  assert.ok(!names.includes("Abu Bakr"), "shorter duplicate should be dropped");
});

test("whisper prompt stays short and keeps the most recent text", () => {
  const tail = "كلمة ".repeat(80) + "آخر الكلام";
  const p = buildWhisperPrompt({ userTerms: ["فلان", "علان"], tail });
  assert.ok(p.length <= 380, `prompt too long: ${p.length}`);
  assert.ok(p.endsWith("آخر الكلام"));
  assert.ok(p.includes("فلان"));
});

test("known whisper hallucinations are caught, real speech is not", () => {
  assert.ok(isKnownHallucination("ترجمة نانسي قنقر"));
  assert.ok(isKnownHallucination("Thanks for watching!"));
  assert.ok(isKnownHallucination("اشتركوا في القناة"));
  assert.ok(!isKnownHallucination("الحمد لله رب العالمين والصلاة والسلام على رسول الله"));
});

test("runaway repetition is collapsed", () => {
  const loop = "سبحان الله ".repeat(20).trim();
  const out = collapseRepeats(loop);
  assert.equal(out.split(" ").length, 6); // 3 x "سبحان الله"
  assert.equal(collapseRepeats("a b c d e"), "a b c d e");
});

test("echo of the prompt is removed", () => {
  const prev = "وقال النبي صلى الله عليه وسلم إنما الأعمال بالنيات";
  assert.equal(dedupeAgainst(prev, "إنما الأعمال بالنيات"), "");
  assert.equal(dedupeAgainst(prev, "صلى الله عليه وسلم إنما الأعمال بالنيات وإنما لكل امرئ ما نوى"), "وإنما لكل امرئ ما نوى");
  assert.equal(dedupeAgainst(prev, "كلام جديد تماما هنا"), "كلام جديد تماما هنا");
});

test("low-confidence segments are dropped", () => {
  const res = {
    text: "x",
    segments: [
      { text: "كلام حقيقي", avg_logprob: -0.3, no_speech_prob: 0.01, compression_ratio: 1.2 },
      { text: "ترجمة نانسي قنقر", avg_logprob: -1.1, no_speech_prob: 0.8, compression_ratio: 1.0 },
      { text: "تكرار تكرار", avg_logprob: -0.5, no_speech_prob: 0.1, compression_ratio: 3.4 },
    ],
  };
  assert.equal(filterSegments(res), "كلام حقيقي");
  assert.equal(cleanTranscript({ text: "", segments: [] }), "");
});

test("translation output is cleaned of tags, labels and quotes", () => {
  assert.equal(cleanTranslation("<think>hmm</think>\nTranslation: “Actions are by intentions.”"), "Actions are by intentions.");
  assert.equal(cleanTranslation("Hello there.\n\nNEXT (Arabic): بسم الله"), "Hello there.");
  assert.equal(cleanTranslation('"He said, "peace" and left."'), '"He said, "peace" and left."');
});

test("prompts include glossary, recent text and the slice to translate", () => {
  const u = buildUserPrompt({ current: "بسم الله", previous: "قبل", next: "بعد", recent: "Earlier text.", glossary: [{ ar: "الله", en: "Allah" }], context: "Seerah class" });
  for (const needle of ["Seerah class", "الله → Allah", "Earlier text.", "CURRENT", "بسم الله", "NEXT"]) assert.ok(u.includes(needle), needle);
  assert.ok(buildSystemPrompt({ honorifics: "full" }).includes("peace and blessings be upon him"));
  assert.ok(buildSystemPrompt({ honorifics: "short" }).includes("ﷺ"));
});
