// Shared test helpers: synthetic audio and fake providers.
export const SR = 16000;

/** seconds of "speech" (a 220 Hz tone with a little vibrato) at the given amplitude */
export function speech(sec, amp = 0.25) {
  const n = Math.round(sec * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * (220 + 20 * Math.sin(i / 3000)) * i) / SR);
  return a;
}

/** seconds of near-silence (very faint noise) */
export function silence(sec, amp = 0.0005) {
  const n = Math.round(sec * SR);
  const a = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    a[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return a;
}

export function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** feed audio to a chunker in odd-sized blocks (like a real mic) */
export function feed(chunker, audio, block = 2048) {
  for (let i = 0; i < audio.length; i += block) chunker.push(audio.subarray(i, Math.min(audio.length, i + block)));
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for condition");
    await wait(10);
  }
}

/** A provider whose behaviour each test scripts. */
export function fakeProvider({ transcribe, chat, name = "fake" } = {}) {
  const calls = { transcribe: [], chat: [] };
  return {
    name,
    calls,
    async transcribe(wav, opts) {
      calls.transcribe.push({ wav, ...opts });
      return transcribe ? transcribe(wav, opts, calls.transcribe.length) : { text: "", language: "", segments: [] };
    },
    async chat(opts) {
      calls.chat.push(opts);
      return chat ? chat(opts, calls.chat.length) : "";
    },
    async listModels() {
      return [];
    },
  };
}

/** Minimal router stand-in for engine tests (no failover logic). */
export function fakeRouter(provider) {
  return {
    providers: { fake: provider },
    reset() {},
    async run(kind, fn) {
      const item = { provider: "fake", model: "m1", id: "fake:m1" };
      return { value: await fn(item), item };
    },
  };
}
