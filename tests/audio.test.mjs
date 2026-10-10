import test from "node:test";
import assert from "node:assert/strict";
import { Chunker } from "../www/js/audio/chunker.js";
import { Resampler } from "../www/js/audio/resample.js";
import { encodeWav } from "../www/js/audio/wav.js";
import { SR, speech, silence, concat, feed } from "./helpers.mjs";

function run(audio, opts = {}) {
  const chunks = [];
  const c = new Chunker({ onChunk: (k) => chunks.push(k), ...opts });
  feed(c, audio);
  c.flush();
  return chunks;
}

test("pure silence/noise produces no chunks", () => {
  assert.equal(run(silence(20)).length, 0);
});

test("a short pause inside a sentence does not split it", () => {
  const chunks = run(concat(silence(0.5), speech(2), silence(1.0), speech(5), silence(2)));
  assert.equal(chunks.length, 1);
  const sec = chunks[0].pcm.length / SR;
  assert.ok(sec > 8 && sec < 9.8, `chunk was ${sec}s`);
});

test("a real pause after enough speech ends the chunk", () => {
  const chunks = run(concat(silence(0.5), speech(5), silence(1.0), speech(5), silence(2)));
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endMs <= chunks[1].startMs + 400);
  assert.ok(chunks[0].startMs < 800);
});

test("continuous speech is cut at the quietest moment, never past the maximum", () => {
  // 30 s of loud speech with a brief dip (soft but not silent) every ~8.4 s
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(speech(8.0), speech(0.25, 0.012));
  }
  const chunks = run(concat(...parts), { maxChunkMs: 9000 });
  assert.ok(chunks.length >= 3, `got ${chunks.length}`);
  for (const k of chunks) assert.ok((k.endMs - k.startMs) <= 9400, `chunk too long ${k.endMs - k.startMs}`);
  // the first cut must land inside the first dip (8.0–8.25 s), i.e. not mid-word
  const firstEnd = chunks[0].endMs;
  assert.ok(firstEnd >= 7900 && firstEnd <= 8700, `first cut at ${firstEnd}`);
});

test("timestamps are continuous audio time", () => {
  const chunks = run(concat(silence(1), speech(4), silence(1), speech(4), silence(2)));
  assert.ok(chunks[0].startMs >= 500 && chunks[0].startMs <= 1000);
  assert.ok(chunks[1].startMs > chunks[0].endMs - 400);
});

test("quiet-speech sensitivity setting works", () => {
  const quiet = concat(silence(1), speech(4, 0.004), silence(2));
  assert.equal(run(quiet, { sensitivityDb: -6 }).length, 0);
  assert.equal(run(quiet, { sensitivityDb: 9 }).length, 1);
});

test("48 kHz -> 16 kHz resampling keeps pitch and level", () => {
  const inRate = 48000;
  const n = inRate; // 1 s
  const sine = new Float32Array(n);
  for (let i = 0; i < n; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / inRate);
  const r = new Resampler(inRate, 16000);
  const out = [];
  for (let i = 0; i < n; i += 1000) out.push(...r.process(sine.subarray(i, i + 1000)));
  assert.ok(Math.abs(out.length - 16000) < 8, `len ${out.length}`);
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 440) <= 2, `crossings ${crossings}`);
  const peak = Math.max(...out.slice(100, 15900).map(Math.abs));
  assert.ok(peak > 0.45 && peak < 0.52, `peak ${peak}`);
});

test("44.1 kHz fractional ratio works across block boundaries", () => {
  const r = new Resampler(44100, 16000);
  let total = 0;
  for (let i = 0; i < 44; i++) total += r.process(new Float32Array(1000)).length;
  assert.ok(Math.abs(total - 16000 * 0.998) < 40, `total ${total}`);
});

test("WAV encoder writes a valid header", async () => {
  const blob = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);
  const buf = new DataView(await blob.arrayBuffer());
  const tag = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => buf.getUint8(o + i)));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(buf.getUint32(24, true), 16000);
  assert.equal(buf.getUint32(40, true), 8);
  assert.equal(buf.getInt16(46, true), 16383);
  assert.equal(buf.getInt16(48, true), -16384);
  assert.equal(blob.type, "audio/wav");
});
