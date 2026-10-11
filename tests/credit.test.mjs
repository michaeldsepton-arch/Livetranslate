// "Out of credit" is told apart from a speed limit, routed around, and shown until the user acts.
import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../www/js/engine/router.js";
import { ApiError, classifyHttp } from "../www/js/engine/errors.js";
import { LectureEngine } from "../www/js/engine/session-engine.js";
import { DEFAULT_SETTINGS } from "../www/js/settings.js";
import { fakeProvider, until } from "./helpers.mjs";

const body = (o) => JSON.stringify({ error: o });
const noCredit = (provider = "openai") => new ApiError("credit", { kind: "quota", credit: true, retryAfterMs: 1800000, provider });

test("services' wording for 'no credit' is recognised; ordinary rate limits are not mistaken for it", () => {
  const openai = classifyHttp("openai", 429, body({ code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." }), null);
  assert.equal(openai.credit, true);
  assert.equal(openai.kind, "quota");
  assert.match(openai.message, /OpenAI credit has run out/);
  assert.equal(classifyHttp("groq", 402, "{}", null).credit, true, "HTTP 402 Payment Required");
  assert.equal(classifyHttp("groq", 429, body({ message: "You have reached your spend limit for this organization." }), null).credit, true);
  assert.equal(classifyHttp("gemini", 429, body({ status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing." }), null).credit, true);
  // not credit problems:
  assert.equal(classifyHttp("openai", 429, body({ message: "Rate limit reached for gpt-4.1 in organization. Please try again in 1.2s." }), null).credit, false);
  assert.equal(classifyHttp("gemini", 429, body({ status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." }), null).credit, false, "Gemini says this for plain per-minute limits");
  assert.equal(classifyHttp("groq", 429, body({ message: "Rate limit reached on tokens per minute (TPM). Please try again in 2s." }), null).credit, false);
  assert.equal(classifyHttp("openai", 401, "{}", null).credit, false);
});

function router(providers, notices, engines = {}) {
  const r = new Router(providers, { engines, sleep: async () => {}, onNotice: (n) => notices.push(n) });
  r.models.openai = { stt: ["gpt-4o-transcribe"], llm: ["gpt-4.1"] };
  r.models.groq = { stt: ["whisper-large-v3"], llm: ["openai/gpt-oss-120b"] };
  return r;
}

test("when one service is out of credit the others carry on, with an alert that names who took over", async () => {
  const notices = [];
  const r = router({ openai: {}, groq: {} }, notices);
  const used = [];
  const out = await r.run("llm", async (it) => {
    used.push(it.id);
    if (it.provider === "openai") throw noCredit();
    return "ok";
  });
  assert.equal(out.value, "ok");
  assert.deepEqual(used, ["openai:gpt-4.1", "groq:openai/gpt-oss-120b"]);
  const n = notices.find((x) => x.credit);
  assert.equal(n.provider, "openai");
  assert.equal(n.level, "warn");
  assert.match(n.text, /OpenAI credit has run out — now using Groq/);
  // it is left out for both speech and translation until told otherwise
  assert.ok(r.chain("stt").every((i) => i.provider !== "openai"));
  const later = [];
  await r.run("stt", async (it) => (later.push(it.id), "ok"));
  assert.deepEqual(later, ["groq:whisper-large-v3"]);
  // "I've added credit": reset() lets it back in
  r.reset();
  assert.equal(r.chain("llm")[0].id, "openai:gpt-4.1");
});

test("when it was the only service, the error says so and asks for credit (error level, no waiting around)", async () => {
  const notices = [];
  const r = router({ openai: {} }, notices);
  await assert.rejects(
    r.run("llm", async () => { throw noCredit(); }),
    (e) => e.kind === "auth" && e.credit === true && /OpenAI credit has run out\. Add credit, then tap Retry/.test(e.message)
  );
  assert.equal(notices.find((x) => x.credit).level, "error");
  // and further calls fail straight away rather than waiting
  await assert.rejects(r.run("stt", async () => "never"), (e) => e.credit === true);
});

test("a lecture waits for credit instead of losing audio, then carries on when credit is added", async () => {
  let funded = false;
  const make = () => {
    const p = fakeProvider({
      name: "openai",
      transcribe: () => {
        if (!funded) throw noCredit();
        return { text: "الكبر من أمراض القلوب الخطيرة", language: "", segments: [] };
      },
      chat: () => "Arrogance is one of the dangerous diseases of the heart.",
    });
    const r = new Router({ openai: p }, { sleep: async () => {} });
    r.models.openai = { stt: ["gpt-4o-transcribe"], llm: ["gpt-4.1"] };
    return r;
  };
  const engine = new LectureEngine({ router: make(), settings: { ...DEFAULT_SETTINGS, languageCheck: false } });
  engine.cfg = { ...engine.cfg, lookaheadWaitMs: 0 };
  const halts = [];
  engine.on("halt", (m) => halts.push(m));
  engine.ingestChunk({ pcm: new Float32Array(1600), startMs: 0, endMs: 4500, voicedMs: 4000 });
  await until(() => halts.length > 0);
  assert.match(halts[0], /credit has run out/);
  const e = engine.entries[0];
  assert.equal(e.state, "error");
  assert.match(e.error, /Waiting for credit/);
  assert.ok(engine.audio.has(e.id), "the audio is kept");
  funded = true;
  engine.resume(make()); // the user added credit and tapped Retry
  await until(() => !engine._busy() && engine.entries[0].state === "done");
  assert.match(engine.entries[0].en, /Arrogance/);
});
