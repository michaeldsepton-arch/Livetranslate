import test from "node:test";
import assert from "node:assert/strict";
import { parseBuildNumber, checkForUpdate, autoCheck, RELEASE_PAGE } from "../www/js/update.js";
import { ApiError } from "../www/js/engine/errors.js";

const BODY = (n) => `**Install on Android:** download \`Lisan.apk\` below.\n\nBuilt from branch \`main\` · commit \`abc\` · run #${n}.\nUpdates install over the previous version.`;
const release = (n, assets = [{ name: "Lisan.apk", browser_download_url: "https://github.com/o/r/releases/download/latest-build/Lisan.apk" }]) => ({ body: BODY(n), assets });
const reply = (status, body, headers = {}) => async () => ({ status, ok: status >= 200 && status < 300, text: typeof body === "string" ? body : JSON.stringify(body), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test("the build number is read from the release text", () => {
  assert.equal(parseBuildNumber(BODY(14)), 14);
  assert.equal(parseBuildNumber("no number here"), 0);
  assert.equal(parseBuildNumber(undefined), 0);
});

test("a newer build is offered with its download link", async () => {
  const r = await checkForUpdate({ http: reply(200, release(20)), current: 15 });
  assert.equal(r.status, "available");
  assert.equal(r.latest, 20);
  assert.equal(r.url, "https://github.com/o/r/releases/download/latest-build/Lisan.apk");
  assert.match(r.message, /build 20/);
  assert.equal(r.page, RELEASE_PAGE);
});

test("the same or an older release means up to date", async () => {
  assert.equal((await checkForUpdate({ http: reply(200, release(15)), current: 15 })).status, "current");
  assert.equal((await checkForUpdate({ http: reply(200, release(12)), current: 15 })).status, "current");
});

test("a copy run from source has nothing to compare and makes no request", async () => {
  let called = false;
  const r = await checkForUpdate({ http: async () => ((called = true), null), current: 0 });
  assert.equal(r.status, "dev");
  assert.equal(called, false);
});

test("a private repository, no connection, rate limiting and odd answers are explained, never thrown", async () => {
  assert.equal((await checkForUpdate({ http: reply(404, { message: "Not Found" }), current: 5 })).status, "private");
  assert.match((await checkForUpdate({ http: reply(404, {}), current: 5 })).message, /make the repository public/);
  assert.equal((await checkForUpdate({ http: reply(403, {}, { "x-ratelimit-remaining": "0" }), current: 5 })).status, "error");
  assert.equal((await checkForUpdate({ http: reply(500, "oops"), current: 5 })).status, "error");
  assert.equal((await checkForUpdate({ http: reply(200, "<html>"), current: 5 })).status, "error");
  assert.equal((await checkForUpdate({ http: reply(200, { body: "nothing", assets: [] }), current: 5 })).status, "error");
  assert.equal((await checkForUpdate({ http: reply(200, release(9, [])), current: 5 })).status, "error", "a release without an APK cannot be offered");
  assert.equal((await checkForUpdate({ http: async () => { throw new ApiError("x", { kind: "network" }); }, current: 5 })).status, "offline");
});

test("the quiet check runs at most every 6 hours, never during a lecture, and only counts real answers", async () => {
  const mem = {};
  const storage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = v) };
  let t = 1_000_000_000;
  let calls = 0;
  let answer = { status: "available", latest: 9 };
  const check = async () => (calls++, answer);
  const run = (isBusy = () => false) => autoCheck({ isBusy, storage, now: () => t, check });

  assert.equal(await run(() => true), null, "recording: do not even ask");
  assert.equal(calls, 0);
  assert.equal((await run()).status, "available");
  assert.equal(calls, 1);
  assert.equal(await run(), null, "asked a moment ago");
  t += 5 * 3600 * 1000;
  assert.equal(await run(), null, "still within 6 hours");
  t += 2 * 3600 * 1000;
  assert.equal((await run()).status, "available", "after 6 hours it asks again");
  assert.equal(calls, 2);

  // no connection: try again soon rather than waiting another 6 hours
  t += 7 * 3600 * 1000;
  answer = { status: "offline" };
  await run();
  assert.equal(calls, 3);
  await run();
  assert.equal(calls, 4, "an offline answer is not remembered");

  // a lecture that started while the answer was on its way: stay quiet
  t += 7 * 3600 * 1000;
  answer = { status: "available", latest: 10 };
  let busy = false;
  const slow = autoCheck({ isBusy: () => busy, storage, now: () => t, check: async () => ((busy = true), answer) });
  assert.equal(await slow, null);

  // broken storage never breaks the app
  assert.equal(await autoCheck({ storage: { getItem() { throw new Error("blocked"); } }, check }), null);
});
