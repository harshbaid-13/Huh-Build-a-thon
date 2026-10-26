/**
 * Streaming downmix + downsampler. Averages every input sample that falls into each output
 * sample's window (a box filter), which is cheap and anti-aliases well enough for speech.
 */
export class Downsampler {
  private readonly ratio: number;
  private pos = 0;
  private acc = 0;
  private accN = 0;

  constructor(inputRate: number, readonly outputRate = 16000) {
    if (inputRate < outputRate) throw new Error(`input rate ${inputRate} is below ${outputRate}`);
    this.ratio = inputRate / outputRate;
  }

  /** `channels` are equal-length planar buffers; returns the 16 kHz mono samples produced. */
  process(channels: Float32Array[]): Float32Array {
    if (channels.length === 0) return new Float32Array(0);
    const n = channels[0].length;
    const out = new Float32Array(Math.ceil(n / this.ratio) + 1);
    let outLen = 0;
    const ch = channels.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += channels[c][i];
      this.acc += s / ch;
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        out[outLen++] = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
      }
    }
    return out.subarray(0, outLen);
  }
}
