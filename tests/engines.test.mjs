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

// ---- OpenAI ----
import { OpenAIProvider } from "../www/js/providers/openai.js";
import { pickOpenAiModels } from "../www/js/providers/models.js";
import { classifyHttp, ApiError } from "../www/js/engine/errors.js";
import { openaiCost, limitsFor } from "../www/js/engine/limits.js";
import { translatorCandidates, compareTranslators } from "../www/js/engine/compare.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: typeof body === "string" ? body : JSON.stringify(body), headers: { get: () => null } });

test("OpenAI transcription: gpt-4o models use json, whisper-1 uses verbose_json, prompt and language are passed", async () => {
  const seen = [];
  const http = async (url, opts) => (seen.push({ url, opts }), res(200, { text: "بسم الله", language: "arabic", duration: 4 }));
  const o = new OpenAIProvider(" sk-test ", http);
  const wav = new Blob(["x"], { type: "audio/wav" });
  const a = await o.transcribe(wav, { model: "gpt-4o-transcribe", language: "ar", prompt: "مقدمة" });
  await o.transcribe(wav, { model: "whisper-1" });
  assert.equal(seen[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(seen[0].opts.headers.Authorization, "Bearer sk-test");
  assert.equal(seen[0].opts.body.get("response_format"), "json");
  assert.equal(seen[0].opts.body.get("language"), "ar");
  assert.equal(seen[0].opts.body.get("prompt"), "مقدمة");
  assert.equal(seen[1].opts.body.get("response_format"), "verbose_json");
  assert.equal(a.text, "بسم الله");
});

test("OpenAI chat: normal models get a temperature; reasoning models get minimal effort and retry plainer on rejection", async () => {
  const bodies = [];
  let fail = 1;
  const http = async (url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    if (b.model === "gpt-5-mini" && b.reasoning_effort === "minimal" && fail-- > 0) return res(400, { error: { message: "Unsupported value: reasoning_effort 'minimal'" } });
    return res(200, { choices: [{ message: { content: "Hello" } }], usage: { total_tokens: 321 } });
  };
  const o = new OpenAIProvider("k", http);
  assert.equal(await o.chat({ model: "gpt-4.1", system: "s", user: "u" }), "Hello");
  assert.equal(bodies[0].temperature, 0.2);
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(o.lastUsage.tokens, 321);
  await o.chat({ model: "gpt-5-mini", system: "s", user: "u" });
  const g = bodies.filter((b) => b.model === "gpt-5-mini");
  assert.deepEqual(g.map((b) => b.reasoning_effort), ["minimal", "low"]);
  assert.ok(g.every((b) => b.temperature === undefined), "reasoning models never get a custom temperature");
  assert.ok(g[0].max_completion_tokens > 900, "reasoning tokens need headroom");
});

test("OpenAI errors: out of credit is a quota problem, a model the project can't use is skipped, a bad key is auth", () => {
  const out = classifyHttp("openai", 429, JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }), null);
  assert.equal(out.kind, "quota");
  assert.match(out.message, /credit has run out/);
  assert.equal(classifyHttp("openai", 403, JSON.stringify({ error: { message: "Project `proj_1` does not have access to model `gpt-4.1`" } }), null).kind, "model");
  assert.equal(classifyHttp("openai", 401, JSON.stringify({ error: { message: "Incorrect API key provided" } }), null).kind, "auth");
  assert.equal(classifyHttp("openai", 429, JSON.stringify({ error: { message: "Rate limit reached for gpt-4.1. Please try again in 1.2s." } }), null).kind, "rate");
});

test("OpenAI model choice prefers gpt-4o-transcribe and fast non-reasoning chat models, falls back to whatever chat model exists", () => {
  assert.deepEqual(pickOpenAiModels(["whisper-1", "gpt-4o-transcribe", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "tts-1"]), { stt: ["gpt-4o-transcribe", "whisper-1"], llm: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"] });
  const odd = pickOpenAiModels(["whisper-1", "gpt-9-turbo", "gpt-9-realtime", "text-embedding-3"]);
  assert.deepEqual(odd.llm, ["gpt-9-turbo"]);
  assert.deepEqual(pickOpenAiModels(null).stt.slice(0, 2), ["gpt-4o-transcribe", "whisper-1"]);
});

test("OpenAI can be chosen first for either stage, and is only a last-resort fallback otherwise", () => {
  const all = { groq: P, gemini: P, openai: P };
  const mkAll = (engines) => { const r = mk(all, engines); r.models.openai = { stt: ["gpt-4o-transcribe", "whisper-1"], llm: ["gpt-4.1", "gpt-4.1-mini"] }; return r; };
  assert.deepEqual(ids(mkAll({ stt: "openai", llm: "openai" }), "stt").slice(0, 3), ["openai:gpt-4o-transcribe", "openai:whisper-1", "groq:whisper-large-v3"]);
  assert.equal(ids(mkAll({ llm: "openai" }), "llm")[0], "openai:gpt-4.1");
  assert.equal(ids(mkAll({}), "llm").at(-1), "openai:gpt-4.1-mini", "auto never starts with the paid service");
  assert.equal(ids(mkAll({ stt: "groq-turbo" }), "stt").at(-1), "openai:whisper-1");
  const only = mk({ openai: P });
  only.models.openai = { stt: ["gpt-4o-transcribe"], llm: ["gpt-4.1"] };
  assert.deepEqual(ids(only, "llm"), ["openai:gpt-4.1"]);
});

test("out of OpenAI credit moves on to the free services instead of stalling", async () => {
  const r = mk({ groq: P, openai: P }, { llm: "openai" });
  r.models.openai = { stt: ["gpt-4o-transcribe"], llm: ["gpt-4.1"] };
  const used = [];
  await r.run("llm", async (it) => {
    used.push(it.id);
    if (it.provider === "openai") throw new ApiError("credit", { kind: "quota", retryAfterMs: 1800000 });
    return "ok";
  });
  assert.deepEqual(used, ["openai:gpt-4.1", "groq:big"]);
});

test("OpenAI cost estimate and no rationing", () => {
  assert.ok(Math.abs(openaiCost("openai:gpt-4o-transcribe", { audioSec: 3600 }) - 0.36) < 1e-9);
  assert.ok(Math.abs(openaiCost("openai:gpt-4o-mini-transcribe", { audioSec: 3600 }) - 0.18) < 1e-9);
  assert.ok(Math.abs(openaiCost("openai:gpt-4.1", { tokens: 600000 }) - 1.38) < 1e-9);
  assert.ok(openaiCost("openai:some-new-model", { tokens: 1e6 }) > 0);
  assert.deepEqual(limitsFor("openai:gpt-4.1"), {}, "no free-tier limits, so no pacing or warnings");
});

test("translator comparison: one row per service, errors reported, usage counted", async () => {
  const groq = fakeProvider({ name: "groq", chat: () => "Groq says hello" });
  const gemini = fakeProvider({ name: "gemini", chat: () => { throw Object.assign(new Error("down"), { kind: "server" }); } });
  const openai = fakeProvider({ name: "openai", chat: () => "OpenAI says hello" });
  openai.lastUsage = { tokens: 900 };
  const router = mk({ groq, gemini, openai });
  router.models.openai = { stt: ["gpt-4o-transcribe"], llm: ["gpt-4.1"] };
  assert.deepEqual(translatorCandidates(router).map((c) => c.key), ["tr:groq", "tr:gemini", "tr:openai"]);
  const usage = new UsageTracker({ storage: null });
  const rows = await compareTranslators({ router, text: "الحمد لله", settings: DEFAULT_SETTINGS, usage });
  assert.equal(rows[0].en, "Groq says hello");
  assert.ok(rows[1].error && !rows[1].en);
  assert.equal(rows[2].en, "OpenAI says hello");
  assert.equal(usage.sumSince("openai:gpt-4.1", 2, 0), 900);
});

test("speech test includes OpenAI's speech models when a key is set", () => {
  const r = mk({ groq: P, openai: P });
  r.models.openai = { stt: ["gpt-4o-transcribe", "whisper-1", "gpt-4o-mini-transcribe"], llm: ["gpt-4.1"] };
  assert.deepEqual(sttCandidates(r).map((c) => c.key), ["large", "large-nohint", "turbo", "openai:gpt-4o-transcribe", "openai:whisper-1"]);
});

test("a Read-only OpenAI key is called out clearly", () => {
  const body = JSON.stringify({ error: { message: "You have insufficient permissions for this operation. Missing scopes: model.request." } });
  const e = classifyHttp("openai", 403, body, null);
  assert.equal(e.kind, "auth");
  assert.match(e.message, /Read only/);
  assert.match(e.message, /"All" permissions/);
});
