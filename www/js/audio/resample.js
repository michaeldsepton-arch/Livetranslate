// Streaming box-filter resampler (device rate -> 16 kHz).  Box averaging doubles as a cheap anti-alias filter.

export class Resampler {
  constructor(inRate, outRate = 16000) {
    this.ratio = inRate / outRate;
    this.buf = new Float32Array(0);
    this.pos = 0;
  }

  process(input) {
    if (this.ratio === 1) return input;
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    const out = [];
    let pos = this.pos;
    const r = this.ratio;
    while (pos + r <= merged.length) {
      const end = pos + r;
      let sum = 0;
      for (let i = Math.floor(pos); i < Math.ceil(end); i++) {
        const overlap = Math.min(i + 1, end) - Math.max(i, pos);
        sum += merged[i] * overlap;
      }
      out.push(sum / r);
      pos = end;
    }
    const drop = Math.floor(pos);
    this.buf = merged.slice(drop);
    this.pos = pos - drop;
    return Float32Array.from(out);
  }
}
