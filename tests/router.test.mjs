import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../www/js/engine/router.js";
import { ApiError } from "../www/js/engine/errors.js";

function mk(providers, extra = {}) {
  const t = { now: 1_000_000, slept: [] };
  const router = new Router(providers, {
    now: () => t.now,
    sleep: async (ms) => {
      t.slept.push(ms);
      t.now += ms;
    },
    onNotice: (n) => (t.notices ||= []).push(n),
    ...extra,
  });
  router.models.groq = { stt: ["w3", "w3t"], llm: ["big", "small"] };
  router.models.gemini = { stt: ["gf"], llm: ["gf"] };
  return { router, t };
}
const P = {};
const err = (kind, retryAfterMs = 0) => new ApiError("x", { kind, retryAfterMs });

test("daily quota on one model switches to the next model (separate allowance)", async () => {
  const { router } = mk({ groq: P });
  const used = [];
  const out = await router.run("llm", async (it) => {
    used.push(it.model);
    if (it.model === "big") throw err("quota", 3_600_000);
    return "ok";
  });
  assert.deepEqual(used, ["big", "small"]);
  assert.equal(out.value, "ok");
  // and the exhausted model stays parked on later calls
  const again = [];
  await router.run("llm", async (it) => (again.push(it.model), "ok"));
  assert.deepEqual(again, ["small"]);
});

test("falls over to Gemini when every Groq model is exhausted", async () => {
  const { router } = mk({ groq: P, gemini: P });
  const used = [];
  await router.run("stt", async (it) => {
    used.push(it.id);
    if (it.provider === "groq") throw err("quota", 3_600_000);
    return 1;
  });
  assert.deepEqual(used, ["groq:w3", "groq:w3t", "gemini:gf"]);
});

test("a short rate limit waits, then retries instead of failing", async () => {
  const { router, t } = mk({ groq: P });
  router.models.groq.llm = ["only"];
  let calls = 0;
  const out = await router.run("llm", async () => {
    if (++calls === 1) throw err("rate", 4000);
    return "done";
  });
  assert.equal(out.value, "done");
  assert.equal(calls, 2);
  assert.ok(t.slept.length >= 1 && t.slept[0] >= 3900);
  assert.ok(t.notices.some((n) => n.code === "rate"));
});

test("a rejected key disables only that provider", async () => {
  const { router } = mk({ groq: P, gemini: P });
  const used = [];
  await router.run("llm", async (it) => {
    used.push(it.id);
    if (it.provider === "groq") throw err("auth");
    return "ok";
  });
  assert.deepEqual(used, ["groq:big", "gemini:gf"]);
  assert.ok(router.dead.has("groq"));
  router.reset();
  assert.ok(!router.dead.has("groq"));
});

test("when no key works, run() throws an auth error", async () => {
  const { router } = mk({ groq: P });
  await assert.rejects(
    () => router.run("llm", async () => { throw err("auth"); }),
    (e) => e.kind === "auth"
  );
  assert.ok(router.exhausted);
});

test("a retired model is skipped permanently", async () => {
  const { router } = mk({ groq: P });
  const used = [];
  await router.run("llm", async (it) => {
    used.push(it.model);
    if (it.model === "big") throw err("model");
    return "ok";
  });
  assert.deepEqual(used, ["big", "small"]);
  assert.ok(router.bad.has("groq:big"));
});

test("network failures retry a few times then surface", async () => {
  const { router, t } = mk({ groq: P });
  let calls = 0;
  await assert.rejects(() => router.run("stt", async () => (calls++, Promise.reject(err("network")))), (e) => e.kind === "network");
  assert.equal(calls, 4);
  assert.ok(t.notices.some((n) => n.code === "offline"));
});

test("unrecoverable errors (bad request) are not retried", async () => {
  const { router } = mk({ groq: P });
  let calls = 0;
  await assert.rejects(() => router.run("llm", async () => (calls++, Promise.reject(err("bad_request")))), (e) => e.kind === "bad_request");
  assert.equal(calls, 1);
});

test("preferGemini puts Gemini first; gives up waiting after maxWaitMs", async () => {
  const { router } = mk({ groq: P, gemini: P }, { preferGemini: true });
  assert.equal(router.chain("llm")[0].provider, "gemini");
  const solo = mk({ groq: P }).router;
  solo.models.groq.llm = ["only"];
  await assert.rejects(() => solo.run("llm", async () => { throw err("quota", 3_600_000); }, { maxWaitMs: 60_000 }), (e) => e.kind === "quota");
});
