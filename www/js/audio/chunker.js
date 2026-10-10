// Turns a continuous 16 kHz mic stream into speech chunks.
//  * cuts at natural pauses once the chunk is long enough,
//  * if the speaker never pauses, cuts at the QUIETEST moment near the maximum length (never mid-word),
//  * ignores silence/noise so no quota is wasted on it.

export const FRAME = 320; // 20 ms at 16 kHz
const FRAME_MS = 20;

export class Chunker {
  /**
   * @param {object} o
   * @param {number} [o.minChunkMs]   don't cut at a pause before this much speech has been heard
   * @param {number} [o.maxChunkMs]   hard limit; cut at the quietest point near it
   * @param {number} [o.endSilenceMs] pause length that ends a chunk
   * @param {number} [o.sensitivityDb] +dB = more sensitive (picks up quieter speech)
   * @param {(chunk:object)=>void} o.onChunk   {pcm, startMs, endMs, voicedMs, avgDb}
   * @param {(level:number)=>void} [o.onLevel] 0..1 smoothed mic level
   * @param {(speaking:boolean)=>void} [o.onSpeech]
   */
  constructor({ minChunkMs = 3500, maxChunkMs = 9000, endSilenceMs = 600, sensitivityDb = 0, longSilenceMs = 1800, onChunk, onLevel, onSpeech } = {}) {
    Object.assign(this, { minChunkMs, maxChunkMs, endSilenceMs, sensitivityDb, longSilenceMs, onChunk, onLevel, onSpeech });
    this.rest = new Float32Array(0);
    this.frameIndex = 0;
    this.floorDb = -55;
    this.inSpeech = false;
    this.pre = [];
    this.cur = [];
    this.curStart = 0;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.level = 0;
  }

  static dbOf(frame) {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    return 20 * Math.log10(Math.sqrt(s / frame.length) + 1e-9);
  }

  push(samples) {
    let data = samples;
    if (this.rest.length) {
      data = new Float32Array(this.rest.length + samples.length);
      data.set(this.rest, 0);
      data.set(samples, this.rest.length);
    }
    let off = 0;
    while (off + FRAME <= data.length) {
      this._frame(data.subarray(off, off + FRAME));
      off += FRAME;
    }
    this.rest = data.slice(off);
  }

  /** Emit whatever speech is pending (call when recording stops). */
  flush() {
    if (this.inSpeech) this._emit(this.cur.length);
    this._reset();
  }

  _reset() {
    this.inSpeech = false;
    this.cur = [];
    this.pre = [];
    this.voicedRun = 0;
    this.silentRun = 0;
    if (this.onSpeech) this.onSpeech(false);
  }

  _frame(raw) {
    const frame = Float32Array.from(raw);
    const db = Chunker.dbOf(frame);
    // adaptive noise floor: falls fast, rises slowly (even more slowly while someone is speaking)
    if (db < this.floorDb) this.floorDb += (db - this.floorDb) * 0.15;
    else this.floorDb += this.inSpeech ? 0.002 : 0.05;
    this.floorDb = Math.min(-32, Math.max(-70, this.floorDb));

    const thr = Math.max(this.floorDb + 9, -52) - this.sensitivityDb;
    const voiced = db > (this.inSpeech ? thr - 3 : thr);
    const idx = this.frameIndex++;

    if (this.onLevel) {
      this.level = this.level * 0.7 + Math.max(0, Math.min(1, (db + 60) / 45)) * 0.3;
      if (idx % 3 === 0) this.onLevel(this.level);
    }

    const f = { data: frame, db, voiced };
    if (!this.inSpeech) {
      this.pre.push(f);
      if (this.pre.length > 12) this.pre.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= 4) {
        this.inSpeech = true;
        this.cur = this.pre.slice();
        this.curStart = idx - this.cur.length + 1;
        this.silentRun = 0;
        if (this.onSpeech) this.onSpeech(true);
      }
      return;
    }

    this.cur.push(f);
    this.silentRun = voiced ? 0 : this.silentRun + 1;
    const durMs = this.cur.length * FRAME_MS;
    const silentMs = this.silentRun * FRAME_MS;
    const speechMs = durMs - silentMs;

    if ((silentMs >= this.endSilenceMs && speechMs >= this.minChunkMs) || silentMs >= this.longSilenceMs) {
      this._emit(this.cur.length - Math.max(0, this.silentRun - 8)); // keep ~160 ms of the pause
      this._reset();
    } else if (durMs >= this.maxChunkMs) {
      this._cutAtQuietest();
    }
  }

  _cutAtQuietest() {
    const n = this.cur.length;
    const lo = Math.max(Math.ceil(this.minChunkMs / FRAME_MS), n - 125); // search the last 2.5 s
    const hi = n - 6;
    let best = hi, bestVal = Infinity;
    for (let i = lo; i <= hi; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += this.cur[Math.min(n - 1, Math.max(0, i + k))].db;
      if (s < bestVal) {
        bestVal = s;
        best = i;
      }
    }
    const cut = best + 3;
    this._emit(cut);
    this.cur = this.cur.slice(cut);
    this.curStart += cut;
    let tail = 0;
    for (let i = this.cur.length - 1; i >= 0 && !this.cur[i].voiced; i--) tail++;
    this.silentRun = tail;
  }

  _emit(count) {
    const frames = this.cur.slice(0, count);
    if (!frames.length) return;
    let voiced = 0, dbSum = 0;
    for (const f of frames) if (f.voiced) { voiced++; dbSum += f.db; }
    const voicedMs = voiced * FRAME_MS;
    const avgDb = voiced ? dbSum / voiced : -90;
    if (voicedMs < 500 || avgDb < -58) return; // a click, cough or hiss — not speech
    const pcm = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => pcm.set(f.data, i * FRAME));
    this.onChunk({ pcm, startMs: this.curStart * FRAME_MS, endMs: (this.curStart + frames.length) * FRAME_MS, voicedMs, avgDb });
  }
}
