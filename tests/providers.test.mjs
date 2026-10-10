import test from "node:test";
import assert from "node:assert/strict";
import { GroqProvider, modelQuirks } from "../www/js/providers/groq.js";
import { GeminiProvider } from "../www/js/providers/gemini.js";
import { pickGroqModels, pickGeminiModels } from "../www/js/providers/models.js";
import { classifyHttp, parseDurationMs, ApiError } from "../www/js/engine/errors.js";

const res = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: typeof body === "string" ? body : JSON.stringify(body),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

test("durations parse", () => {
  assert.equal(parseDurationMs("2m3.5s"), 123500);
  assert.equal(parseDurationMs("520ms"), 520);
  assert.equal(parseDurationMs("34s"), 34000);
  assert.equal(parseDurationMs("1h2m"), 3720000);
  assert.equal(parseDurationMs("12"), 12000);
  assert.equal(parseDurationMs(null), 0);
});

test("error classification: key, quota vs rate limit, model, server", () => {
  const per = (msg, h) => classifyHttp("groq", 429, JSON.stringify({ error: { message: msg } }), { get: (k) => (h || {})[k] ?? null });
  assert.equal(classifyHttp("groq", 401, "{}", null).kind, "auth");
  assert.equal(per("Rate limit reached on tokens per minute (TPM). Please try again in 2.5s.").kind, "rate");
  assert.equal(per("Rate limit reached on tokens per minute (TPM). Please try again in 2.5s.").retryAfterMs, 2500);
  assert.equal(per("Rate limit reached for model on tokens per day (TPD): Limit 200000. Please try again in 14m2s.").kind, "quota");
  assert.equal(per("Rate limit reached on audio seconds per hour (ASH). Please try again in 41m0s.").kind, "quota"); // > 2 min wait
  assert.equal(classifyHttp("groq", 404, JSON.stringify({ error: { message: "The model `x` does not exist" } }), null).kind, "model");
  assert.equal(classifyHttp("groq", 400, JSON.stringify({ error: { message: "The model `x` has been decommissioned" } }), null).kind, "model");
  assert.equal(classifyHttp("groq", 503, "oops", null).kind, "server");
  assert.equal(classifyHttp("gemini", 429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }), null).kind, "quota");
  assert.equal(classifyHttp("gemini", 429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for per minute", details: [{ retryDelay: "34s" }] } }), null).retryAfterMs, 34000);
  assert.equal(classifyHttp("groq", 429, "{}", { get: (k) => (k === "retry-after" ? "7" : null) }).retryAfterMs, 7000);
});

test("groq transcribe sends the right multipart fields and parses verbose_json", async () => {
  let seen;
  const http = async (url, opts) => {
    seen = { url, opts };
    return res(200, { text: "بسم الله", language: "arabic", duration: 4.2, segments: [{ text: "بسم الله", avg_logprob: -0.2, no_speech_prob: 0.01 }] });
  };
  const g = new GroqProvider(" gsk_test ", http);
  const out = await g.transcribe(new Blob(["x"], { type: "audio/wav" }), { model: "whisper-large-v3", prompt: "مقدمة", language: undefined });
  assert.equal(seen.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(seen.opts.headers.Authorization, "Bearer gsk_test");
  const fd = seen.opts.body;
  assert.equal(fd.get("model"), "whisper-large-v3");
  assert.equal(fd.get("response_format"), "verbose_json");
  assert.equal(fd.get("prompt"), "مقدمة");
  assert.equal(fd.get("language"), null); // auto-detect so the English interpreter is recognised
  assert.ok(fd.get("file") instanceof Blob);
  assert.deepEqual([out.text, out.language, out.segments.length], ["بسم الله", "arabic", 1]);
  await g.transcribe(new Blob(["x"]), { model: "whisper-large-v3", language: "ar" });
  assert.equal(seen.opts.body.get("language"), "ar");
});

test("groq chat adds model quirks but retries without them if rejected", async () => {
  const bodies = [];
  const http = async (_u, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    if (b.reasoning_effort) return res(400, { error: { message: "unsupported parameter reasoning_effort" } });
    return res(200, { choices: [{ message: { content: "Hello" } }] });
  };
  const g = new GroqProvider("k", http);
  assert.equal(await g.chat({ model: "openai/gpt-oss-120b", system: "s", user: "u" }), "Hello");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(bodies[1].reasoning_effort, undefined);
  assert.deepEqual(modelQuirks("llama-3.3-70b-versatile"), {});
});

test("groq models list + errors", async () => {
  const g = new GroqProvider("k", async () => res(200, { data: [{ id: "a" }, { id: "b" }] }));
  assert.deepEqual(await g.listModels(), ["a", "b"]);
  const bad = new GroqProvider("k", async () => res(401, { error: { message: "Invalid API Key" } }));
  await assert.rejects(() => bad.listModels(), (e) => e instanceof ApiError && e.kind === "auth");
});

test("gemini transcribe sends inline audio and parses JSON; chat uses system instruction", async () => {
  const seen = [];
  const http = async (url, opts) => {
    seen.push({ url, opts, body: JSON.parse(opts.body) });
    if (url.includes("generateContent") && seen.length === 1)
      return res(200, { candidates: [{ content: { parts: [{ text: '{"language":"ar","text":"السلام عليكم"}' }] } }] });
    return res(200, { candidates: [{ content: { parts: [{ text: "Peace be upon you" }] } }] });
  };
  const g = new GeminiProvider("AIza", http);
  const t = await g.transcribe(new Blob(["RIFFxxxx"], { type: "audio/wav" }), { model: "gemini-2.5-flash", prompt: "تمهيد" });
  assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(seen[0].opts.headers["x-goog-api-key"], "AIza");
  const parts = seen[0].body.contents[0].parts;
  assert.equal(parts[1].inlineData.mimeType, "audio/wav");
  assert.ok(parts[1].inlineData.data.length > 4);
  assert.deepEqual([t.text, t.language], ["السلام عليكم", "ar"]);
  const c = await g.chat({ model: "gemini-2.5-flash", system: "SYS", user: "USR" });
  assert.equal(c, "Peace be upon you");
  assert.equal(seen[1].body.systemInstruction.parts[0].text, "SYS");
});

test("gemini retries without thinkingConfig on 400", async () => {
  let n = 0;
  const http = async (_u, opts) => {
    n++;
    const b = JSON.parse(opts.body);
    if (b.generationConfig.thinkingConfig) return res(400, { error: { message: "Unknown name thinkingConfig" } });
    return res(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  };
  assert.equal(await new GeminiProvider("k", http).chat({ model: "gemini-2.0-flash", system: "s", user: "u" }), "ok");
  assert.equal(n, 2);
});

test("model pickers prefer what is available and survive an empty list", () => {
  const g = pickGroqModels(["whisper-large-v3-turbo", "whisper-large-v3", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "llama-guard-4"]);
  assert.deepEqual(g.stt, ["whisper-large-v3", "whisper-large-v3-turbo"]);
  assert.deepEqual(g.llm, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  const odd = pickGroqModels(["brand-new-chat-model", "whisper-large-v3", "some-guard"]);
  assert.deepEqual(odd.llm, ["brand-new-chat-model"]);
  assert.ok(pickGroqModels(null).llm.length >= 2);
  const gem = pickGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3-flash", "gemini-3-flash-preview", "gemini-2.5-pro", "embedding-001"]);
  assert.deepEqual(gem.llm, ["gemini-3-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
  assert.ok(pickGeminiModels(null).llm.length === 2);
});
