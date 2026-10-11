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
  const sent = provider.calls.transcribe[0];
  assert.equal(sent.model, "gpt-4o-transcribe");
  assert.equal(sent.prompt, buildOpenAiPrompt({ userTerms: ["ابن تيمية"] }));
  assert.match(sent.prompt, /ابن تيمية/);
  assert.ok(!sent.prompt.includes("الحمد لله رب العالمين"), "no Arabic primer to echo");
  assert.ok(sent.prompt.length < 200);
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
