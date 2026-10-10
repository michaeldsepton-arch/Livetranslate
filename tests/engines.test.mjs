import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../www/js/engine/router.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../www/js/settings.js";
import { compareEngines, sttCandidates } from "../www/js/engine/compare.js";
import { describeLevel } from "../www/js/ui/speech-test.js";
import { UsageTracker } from "../www/js/engine/usage.js";
import { fakeProvider, speech, silence } from "./helpers.mjs";

function mk(providers, engines) {
  const router = new Router(providers, { engines, sleep: async () => {} });
  router.models.groq = { stt: ["whisper-large-v3", "whisper-large-v3-turbo"], llm: ["big", "small"] };
  router.models.gemini = { stt: ["gemini-2.5-flash"], llm: ["gemini-2.5-flash"] };
  return router;
}
const ids = (router, kind) => router.chain(kind).map((i) => i.id);
const P = {};

test("auto keeps Whisper large-v3 first, then turbo, then Gemini", () => {
  assert.deepEqual(ids(mk({ groq: P, gemini: P }), "stt"), ["groq:whisper-large-v3", "groq:whisper-large-v3-turbo", "gemini:gemini-2.5-flash"]);
});

test("choosing turbo puts it first and keeps the others as fallbacks", () => {
  const r = mk({ groq: P, gemini: P }, { stt: "groq-turbo" });
  assert.deepEqual(ids(r, "stt"), ["groq:whisper-large-v3-turbo", "groq:whisper-large-v3", "gemini:gemini-2.5-flash"]);
  assert.deepEqual(ids(r, "llm"), ["groq:big", "groq:small", "gemini:gemini-2.5-flash"], "translation order is untouched by the speech choice");
});

test("speech and translation engines are chosen independently", () => {
  const r = mk({ groq: P, gemini: P }, { stt: "groq", llm: "gemini" });
  assert.equal(ids(r, "stt")[0], "groq:whisper-large-v3");
  assert.equal(ids(r, "llm")[0], "gemini:gemini-2.5-flash");
  const g = mk({ groq: P, gemini: P }, { stt: "gemini", llm: "groq" });
  assert.equal(ids(g, "stt")[0], "gemini:gemini-2.5-flash");
  assert.equal(ids(g, "llm")[0], "groq:big");
});

test("a chosen engine with no key falls through to the one that has a key", () => {
  assert.deepEqual(ids(mk({ groq: P }, { stt: "gemini", llm: "gemini" }), "stt"), ["groq:whisper-large-v3", "groq:whisper-large-v3-turbo"]);
  assert.deepEqual(ids(mk({ gemini: P }, { stt: "groq-turbo" }), "stt"), ["gemini:gemini-2.5-flash"]);
});

test("the old 'Use Gemini first' switch becomes both engine choices", () => {
  const store = { v: JSON.stringify({ geminiKey: "k", preferGemini: true }), getItem() { return this.v; }, setItem(_, v) { this.v = v; } };
  const s = loadSettings(store);
  assert.equal(s.sttEngine, "gemini");
  assert.equal(s.llmEngine, "gemini");
  assert.equal(s.preferGemini, false);
  // a deliberate later choice is never overridden
  saveSettings({ ...s, sttEngine: "groq-turbo" }, store);
  assert.equal(loadSettings(store).sttEngine, "groq-turbo");
  assert.equal(loadSettings({ getItem: () => null }).sttEngine, DEFAULT_SETTINGS.sttEngine);
});

test("speech test offers one row per engine, including large-v3 without the vocabulary hint", () => {
  const r = mk({ groq: P, gemini: P });
  assert.deepEqual(sttCandidates(r).map((c) => c.key), ["large", "large-nohint", "turbo", "gemini"]);
  assert.deepEqual(sttCandidates(mk({ gemini: P })).map((c) => c.key), ["gemini"]);
  r.dead.add("groq");
  assert.deepEqual(sttCandidates(r).map((c) => c.key), ["gemini"]);
});

test("speech test runs the same clip through every engine, translates, records usage, and survives one failing", async () => {
  const groq = fakeProvider({
    name: "groq",
    transcribe: (wav, o) => {
      if (o.model.includes("turbo")) throw Object.assign(new Error("boom"), { kind: "server" });
      return { text: o.prompt ? "بسم الله مع التلميح" : "بسم الله بلا تلميح", language: "arabic" };
    },
    chat: () => "In the name of Allah",
  });
  groq.lastUsage = { tokens: 700 };
  const gemini = fakeProvider({ name: "gemini", transcribe: () => ({ text: "بسم الله جيميني", language: "ar" }), chat: () => "In the name of God" });
  const router = mk({ groq, gemini }, { llm: "groq" });
  const usage = new UsageTracker({ storage: null });
  const seen = [];
  const wav = { size: 123 };
  const rows = await compareEngines({ router, wav, seconds: 8, settings: { ...DEFAULT_SETTINGS, lectureLang: "ar" }, usage, onRow: (r) => seen.push(r.key + ":" + r.state), now: (() => { let t = 0; return () => (t += 500); })() });

  assert.deepEqual(rows.map((r) => r.key), ["large", "large-nohint", "turbo", "gemini"]);
  assert.ok(groq.calls.transcribe.every((c) => c.wav === wav && c.language === "ar"), "identical clip, Arabic forced when the setting says so");
  const [large, noHint, turbo, gem] = rows;
  assert.match(large.text, /مع التلميح/);
  assert.match(noHint.text, /بلا تلميح/);
  assert.equal(groq.calls.transcribe.find((c) => c.model === "whisper-large-v3" && !c.prompt) !== undefined, true, "the 'no hint' row sends no prompt");
  assert.ok(turbo.error, "a failing engine is reported, not fatal");
  assert.equal(turbo.text, "");
  assert.equal(gem.text, "بسم الله جيميني");
  assert.equal(large.en, "In the name of Allah");
  assert.ok(seen.includes("gemini:done"));
  assert.ok(large.ms > 0);
  // counts against the allowance: each speech call is billed at least 10 s
  const mins = usage.byId["groq:whisper-large-v3"];
  const audio = Object.values(mins).reduce((n, b) => n + b[1], 0);
  assert.ok(audio >= 20, "two large-v3 calls, 10 s billed each");
});

test("level read-out flags silence, very quiet and clipped recordings", () => {
  assert.equal(describeLevel(silence(2, 0.0001)).ok, false);
  assert.match(describeLevel(silence(2, 0.0001)).text, /No sound/);
  assert.match(describeLevel(speech(2, 0.01)).text, /quiet/i);
  assert.match(describeLevel(speech(2, 1)).text, /clipping/);
  assert.equal(describeLevel(speech(2, 0.25)).ok, true);
});
