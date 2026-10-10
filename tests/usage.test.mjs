import test from "node:test";
import assert from "node:assert/strict";
import { UsageTracker, startOfDayInTz } from "../www/js/engine/usage.js";
import { limitsFor, MIN_BILLED_AUDIO_SEC } from "../www/js/engine/limits.js";
import { Router } from "../www/js/engine/router.js";

class Mem { constructor() { this.m = {}; } getItem(k) { return this.m[k] ?? null; } setItem(k, v) { this.m[k] = String(v); } }
const mk = (t0 = Date.UTC(2026, 9, 10, 12, 0, 0)) => { const clock = { t: t0 }; const store = new Mem(); const u = new UsageTracker({ storage: store, now: () => clock.t }); return { u, clock, store }; };
const W = "groq:whisper-large-v3";
const L = "groq:openai/gpt-oss-120b";

test("known free limits", () => {
  assert.deepEqual(limitsFor(W), { rpm: 20, rpd: 2000, ash: 7200, asd: 28800 });
  assert.equal(limitsFor(L).tpd, 200000);
  assert.deepEqual(limitsFor("gemini:gemini-2.5-flash"), {});
  assert.equal(MIN_BILLED_AUDIO_SEC, 10);
});

test("speech usage: this hour / today, with bars as fractions of the limit", () => {
  const { u, clock } = mk();
  for (let i = 0; i < 100; i++) { u.record(W, { audio: 10 }); clock.t += 30000; } // 100 requests over 50 min, 1000 s billed
  const rows = Object.fromEntries(u.rows(W).map((r) => [r.key, r]));
  assert.equal(rows.ash.used, 1000);
  assert.ok(Math.abs(rows.ash.frac - 1000 / 7200) < 1e-9);
  assert.equal(rows.asd.used, 1000);
  assert.equal(rows.rpd.used, 100);
  assert.equal(rows.rpd.limit, 2000);
  clock.t += 2 * 3600000; // two hours later: the hourly window is empty again, the daily one is not
  const later = Object.fromEntries(u.rows(W).map((r) => [r.key, r]));
  assert.equal(later.ash.used, 0);
  assert.equal(later.asd.used, 1000);
  clock.t += 23 * 3600000; // a day later it has rolled off
  assert.equal(u.rows(W).find((r) => r.key === "asd").used, 0);
});

test("translation usage counts tokens and requests", () => {
  const { u } = mk();
  u.record(L, { tokens: 900 });
  u.record(L, { tokens: 1100 });
  const rows = Object.fromEntries(u.rows(L).map((r) => [r.key, r]));
  assert.equal(rows.tpd.used, 2000);
  assert.equal(rows.tpd.limit, 200000);
  assert.equal(rows.rpd.used, 2);
});

test("models without known limits still show usage, with no bar", () => {
  const { u } = mk();
  u.record("gemini:gemini-2.5-flash", { tokens: 500 });
  const rows = u.rows("gemini:gemini-2.5-flash");
  assert.ok(rows.every((r) => r.frac === null));
  assert.equal(rows.find((r) => r.key === "tpd").used, 500);
});

test("numbers reported by the service itself win over estimates", () => {
  const { u } = mk();
  u.record(L, { tokens: 100 });
  u.setReported(L, { limitRequests: 14400, remainingRequests: 14000 });
  const r = u.rows(L).find((x) => x.key === "rpd");
  assert.equal(r.limit, 14400);
  assert.equal(r.used, 400);
  assert.ok(r.reported);
});

test("it survives an app restart", async () => {
  const { u, clock, store } = mk();
  u.record(W, { audio: 12 });
  await new Promise((r) => setTimeout(r, 1700));
  const again = new UsageTracker({ storage: store, now: () => clock.t });
  assert.equal(again.rows(W).find((r) => r.key === "asd").used, 12);
});

test("headline picks the most-used known limit", () => {
  const { u } = mk();
  u.record(W, { audio: 3600 });
  u.record(L, { tokens: 1000 });
  const h = u.headline([W, L]);
  assert.equal(h.id, W);
  assert.ok(h.frac >= 0.5);
});

test("pace: waits only when a model is near its per-minute limit", () => {
  const { u, clock } = mk();
  for (let i = 0; i < 17; i++) u.touch(W); // 90% of 20 = 18
  assert.equal(u.pace(W), 0);
  u.touch(W);
  u.touch(W);
  const wait = u.pace(W);
  assert.ok(wait > 0 && wait <= 60100, `wait ${wait}`);
  clock.t += 61000;
  assert.equal(u.pace(W), 0);
  assert.equal(u.pace("gemini:gemini-2.5-flash"), 0, "no pacing without a known limit");
});

test("minutes of speech left at the current pace", () => {
  const { u, clock } = mk();
  for (let i = 0; i < 10; i++) { u.record(W, { audio: 100 }); clock.t += 60000; } // 100 s per minute for 10 min
  const left = u.minutesLeft(W);
  assert.equal(left, 62); // hourly cap binds first: (7200 - 1000 used) / 100 per minute
  assert.equal(mk().u.minutesLeft(W), null, "no recent activity -> no estimate");
});

test("Pacific midnight for Gemini's daily reset", () => {
  const noonUtc = Date.UTC(2026, 9, 10, 12, 0, 0); // 05:00 in Los Angeles (PDT)
  const start = startOfDayInTz(noonUtc, "America/Los_Angeles");
  assert.equal(new Date(start).toISOString(), "2026-10-10T07:00:00.000Z");
});

test("router paces itself: with the first Whisper model busy it uses the next one instead of hitting a 429", async () => {
  const { u } = mk();
  const slept = [];
  const router = new Router({ groq: {} }, { usage: u, now: () => u.now(), sleep: async (ms) => slept.push(ms) });
  router.models.groq = { stt: ["whisper-large-v3", "whisper-large-v3-turbo"], llm: ["x"] };
  const used = [];
  for (let i = 0; i < 24; i++) await router.run("stt", async (it) => (used.push(it.model), 1));
  const first = used.filter((m) => m === "whisper-large-v3").length;
  const second = used.filter((m) => m === "whisper-large-v3-turbo").length;
  assert.equal(first, 18, "stays under 90% of 20 requests per minute");
  assert.equal(second, 6, "overflow goes to the next model");
  assert.equal(slept.length, 0, "and nothing had to wait");
});

test("the estimate uses the pace while recording, not an average diluted by idle minutes", () => {
  const { u } = mk();
  for (let i = 0; i < 8; i++) u.record(W, { audio: 10 }); // a 20-second burst: 80 s billed within one minute
  assert.equal(u.minutesLeft(W), Math.floor((7200 - 80) / 80)); // 89
});

test("translation models: how long the daily tokens last at the current pace", () => {
  const { u, clock } = mk();
  for (let i = 0; i < 5; i++) { u.record(L, { tokens: 10000 }); clock.t += 60000; } // 10k tokens per minute for 5 minutes
  assert.equal(u.minutesLeft(L), Math.floor((200000 - 50000) / 10000)); // 15
});

test("paid plans: no free-tier limits, bars, estimates or pacing", () => {
  const { u } = mk();
  u.paid = { groq: true };
  for (let i = 0; i < 40; i++) { u.touch(W); u.record(W, { audio: 10 }); }
  assert.equal(u.pace(W), 0);
  assert.ok(u.rows(W).every((r) => r.frac === null && r.limit === null));
  assert.equal(u.headline([W]), null);
  assert.equal(u.minutesLeft(W), null);
  u.paid = {};
  assert.ok(u.rows(W).some((r) => r.limit));
});
