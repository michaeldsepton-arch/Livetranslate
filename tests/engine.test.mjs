import test from "node:test";
import assert from "node:assert/strict";
import { LectureEngine } from "../www/js/engine/session-engine.js";
import { Router } from "../www/js/engine/router.js";
import { ApiError } from "../www/js/engine/errors.js";
import { DEFAULT_SETTINGS } from "../www/js/settings.js";
import { fakeProvider, fakeRouter, until, wait } from "./helpers.mjs";

const AR1 = "بسم الله الرحمن الرحيم الحمد لله رب العالمين";
const AR2 = "وصلى الله وسلم على نبينا محمد";
const AR3 = "قال عمر بن الخطاب رضي الله عنه";
const EN1 = "Good evening everyone, the Sheikh began by praising Allah.";

const chunk = (n = 0) => ({ pcm: new Float32Array(1600), startMs: n * 5000, endMs: n * 5000 + 4500, voicedMs: 4000 });
const sttText = (map) => (_wav, _o, call) => ({ text: map[call - 1], language: /[a-z]/i.test(map[call - 1] || "") ? "english" : "arabic", segments: [] });

function setup({ stt, chat, settings = {}, wait: lookahead = 0 }) {
  const provider = fakeProvider({ transcribe: stt, chat });
  const engine = new LectureEngine({ router: fakeRouter(provider), settings: { ...DEFAULT_SETTINGS, ...settings } });
  engine.cfg = { ...engine.cfg, lookaheadWaitMs: lookahead };
  return { engine, provider };
}
const settled = (engine) => until(() => !engine._busy());

test("Arabic is translated; English interpreter lines are shown as-is and never sent for translation", async () => {
  const { engine, provider } = setup({
    stt: sttText([AR1, EN1, AR3]),
    chat: ({ user }) => (user.includes(AR1) ? "In the name of Allah, the Most Gracious, the Most Merciful." : "Umar ibn al-Khattab (RA) said:"),
  });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  engine.ingestChunk(chunk(1));
  await settled(engine);
  engine.ingestChunk(chunk(2));
  await settled(engine);

  const [a, b, c] = engine.entries;
  assert.deepEqual([a.kind, b.kind, c.kind], ["lecture", "interpreter", "lecture"]);
  assert.equal(a.en, "In the name of Allah, the Most Gracious, the Most Merciful.");
  assert.equal(b.en, EN1);
  assert.equal(b.ar, "");
  assert.equal(provider.calls.chat.length, 2, "the interpreter's English must not be translated");
  // the interpreter's words are given to the translator as context for what follows
  assert.ok(provider.calls.chat[1].user.includes("Interpreter: Good evening"));
  assert.ok(provider.calls.chat[1].user.includes("In the name of Allah"));
  assert.ok(provider.calls.chat[1].user.includes("عمر بن الخطاب → Umar ibn al-Khattab"), "glossary hint for the name");
});

test("results are committed in speech order even when the network answers out of order", async () => {
  const { engine, provider } = setup({
    stt: async (_w, _o, call) => {
      if (call === 1) await wait(150); // first chunk is the slowest
      return { text: [AR1, AR2][call - 1], language: "arabic", segments: [] };
    },
    chat: ({ user }) => (user.includes("CURRENT (translate this):\n" + AR1) ? "First." : "Second."),
  });
  engine.ingestChunk(chunk(0));
  engine.ingestChunk(chunk(1));
  await settled(engine);
  assert.deepEqual(engine.entries.map((e) => e.en), ["First.", "Second."]);
  assert.ok(provider.calls.chat[0].user.includes(AR1));
  assert.ok(provider.calls.chat[1].user.includes("First."), "second translation continues from the first");
});

test("look-ahead: the next sentence is shown to the translator when it arrives in time", async () => {
  const { engine, provider } = setup({ stt: sttText([AR1, AR2]), chat: () => "ok", wait: 400 });
  engine.ingestChunk(chunk(0));
  await wait(60);
  assert.equal(provider.calls.chat.length, 0, "must hold the sentence while waiting for what follows");
  engine.ingestChunk(chunk(1));
  await settled(engine);
  assert.ok(provider.calls.chat[0].user.includes("NEXT (Arabic, context only — do not translate):\n" + AR2));
  assert.ok(provider.calls.chat[1].user.includes("PREVIOUS (Arabic, context only):\n" + AR1));
});

test("look-ahead gives up after the wait time (never stalls the lecture)", async () => {
  const { engine, provider } = setup({ stt: sttText([AR1]), chat: () => "ok", wait: 150 });
  engine.ingestChunk(chunk(0));
  await wait(60);
  assert.equal(provider.calls.chat.length, 0);
  await settled(engine);
  assert.ok(provider.calls.chat[0].user.includes("(not available yet)"));
});

test("Quick mode translates immediately", async () => {
  const { engine, provider } = setup({ stt: sttText([AR1]), chat: () => "ok", wait: 0 });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  assert.equal(provider.calls.chat.length, 1);
});

test("an interpreter line releases the waiting Arabic immediately", async () => {
  const { engine, provider } = setup({ stt: sttText([AR1, EN1]), chat: () => "ok", wait: 5000 });
  engine.ingestChunk(chunk(0));
  await wait(40);
  engine.ingestChunk(chunk(1));
  await settled(engine);
  assert.equal(engine.entries[0].state, "done");
  assert.equal(provider.calls.chat.length, 1);
});

test("finish() flushes everything without waiting for look-ahead", async () => {
  const { engine } = setup({ stt: sttText([AR1]), chat: () => "Done.", wait: 60000 });
  engine.ingestChunk(chunk(0));
  await wait(30);
  await engine.finish(3000);
  assert.equal(engine.entries[0].en, "Done.");
});

test("phantom subtitles and empty results never reach the transcript", async () => {
  const { engine, provider } = setup({ stt: sttText(["ترجمة نانسي قنقر", "", "Thank you.", AR1]), chat: () => "Real." });
  for (let i = 0; i < 4; i++) {
    engine.ingestChunk(chunk(i));
    await settled(engine);
  }
  assert.equal(engine.entries.length, 1);
  assert.equal(engine.entries[0].ar, AR1);
  assert.equal(provider.calls.chat.length, 1);
});

test("Arabic mistaken for Persian/Urdu is re-recognised as Arabic", async () => {
  const langs = [];
  const { engine } = setup({
    stt: (_w, o, call) => {
      langs.push(o.language);
      return { text: AR1, language: call === 1 ? "persian" : "arabic", segments: [] };
    },
    chat: () => "ok",
  });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  assert.deepEqual(langs, [undefined, "ar"]);
});

test("Arabic-only mode forces the language", async () => {
  const langs = [];
  const { engine } = setup({ stt: (_w, o) => (langs.push(o.language), { text: AR1, language: "arabic", segments: [] }), chat: () => "ok", settings: { lectureLang: "ar" } });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  assert.deepEqual(langs, ["ar"]);
});

test("the speech recogniser is primed with the previous Arabic and the user's own terms", async () => {
  const prompts = [];
  const { engine } = setup({ stt: (_w, o, call) => (prompts.push(o.prompt), { text: [AR1, AR2][call - 1], language: "arabic", segments: [] }), chat: () => "ok", settings: { customGlossary: [{ ar: "الشيخ فلان", en: "Shaykh Fulan" }] } });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  engine.ingestChunk(chunk(1));
  await settled(engine);
  assert.ok(prompts[0].includes("الشيخ فلان"));
  assert.ok(prompts[1].endsWith("رب العالمين"), "tail of the previous transcript comes last");
});

test("a failed translation keeps the Arabic and can be retried", async () => {
  let fail = true;
  const { engine } = setup({ stt: sttText([AR1]), chat: () => { if (fail) throw new ApiError("boom", { kind: "bad_request" }); return "Recovered."; } });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  const e = engine.entries[0];
  assert.equal(e.state, "error");
  assert.equal(e.ar, AR1);
  fail = false;
  engine.retry(e.id);
  await settled(engine);
  assert.equal(e.state, "done");
  assert.equal(e.en, "Recovered.");
});

test("a rejected key halts processing, keeps the audio, and resume() carries on", async () => {
  let badKey = true;
  const provider = fakeProvider({
    transcribe: () => {
      if (badKey) throw new ApiError("Invalid API Key", { kind: "auth" });
      return { text: AR1, language: "arabic", segments: [] };
    },
    chat: () => "Fine.",
  });
  const router = new Router({ groq: provider }, { sleep: async () => {} });
  router.models.groq = { stt: ["w"], llm: ["m"] };
  const engine = new LectureEngine({ router, settings: { ...DEFAULT_SETTINGS } });
  engine.cfg = { ...engine.cfg, lookaheadWaitMs: 0 };
  const halts = [];
  engine.on("halt", (m) => halts.push(m));
  engine.ingestChunk(chunk(0));
  await until(() => halts.length === 1);
  assert.equal(engine.entries[0].state, "error");
  badKey = false;
  engine.resume(router);
  await settled(engine);
  assert.equal(engine.entries[0].en, "Fine.");
});

test("translations are final: once committed an entry is never rewritten", async () => {
  const { engine } = setup({ stt: sttText([AR1, AR2]), chat: (_o, n) => `Translation ${n}.`, wait: 0 });
  const seen = [];
  engine.on("entry", (e) => e.state === "done" && seen.push(`${e.id}:${e.en}`));
  engine.ingestChunk(chunk(0));
  await settled(engine);
  engine.ingestChunk(chunk(1));
  await settled(engine);
  const first = engine.entries[0];
  assert.equal(seen.filter((s) => s.startsWith(first.id)).length, 1, "emitted as done exactly once");
  assert.equal(first.en, "Translation 1.");
});

test("snapshot contains only usable, serialisable entries", async () => {
  const { engine } = setup({ stt: sttText([AR1, EN1]), chat: () => "Hi." });
  engine.ingestChunk(chunk(0));
  engine.ingestChunk(chunk(1));
  await settled(engine);
  const snap = engine.snapshot();
  assert.equal(snap.length, 2);
  assert.ok(!("sttDoneAt" in snap[0]));
  JSON.stringify(snap);
});

test("a recogniser that writes English speech in Arabic letters (or translates Arabic) is re-run with the language forced", async () => {
  const calls = [];
  const { engine } = setup({
    stt: (_w, o, call) => {
      calls.push({ language: o.language, prompt: o.prompt });
      if (call === 1) return { text: "جود ايفنينغ ايفريوان", language: "english", segments: [] }; // English labelled, Arabic letters
      if (call === 2) return { text: EN1, language: "english", segments: [] };
      if (call === 3) return { text: "Praise be to Allah", language: "arabic", segments: [] }; // Arabic audio, English text
      return { text: AR1, language: "arabic", segments: [] };
    },
    chat: () => "ok",
  });
  engine.ingestChunk(chunk(0));
  await settled(engine);
  engine.ingestChunk(chunk(1));
  await settled(engine);
  assert.deepEqual(calls.slice(0, 2).map((c) => c.language), [undefined, "en"]);
  assert.equal(calls[1].prompt, "", "no Arabic primer when forcing English");
  assert.equal(engine.entries[0].kind, "interpreter");
  assert.equal(engine.entries[0].en, EN1);
  assert.deepEqual(calls.slice(2).map((c) => c.language), [undefined, "ar"]);
  assert.equal(engine.entries[1].kind, "lecture");
  assert.equal(engine.entries[1].ar, AR1);
});
