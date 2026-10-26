// AudioWorkletProcessor: downmix to mono, downsample to 16 kHz, post ~100ms frames.
import { Downsampler } from './lib/resample';

// Minimal typings for the AudioWorkletGlobalScope (not in lib.dom).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const FRAME = 1600; // 100ms at 16 kHz

class RecorderProcessor extends AudioWorkletProcessor {
  private ds = new Downsampler(sampleRate, 16000);
  private out = new Float32Array(FRAME);
  private outLen = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const samples = this.ds.process(input);
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(FRAME - this.outLen, samples.length - i);
      this.out.set(samples.subarray(i, i + n), this.outLen);
      this.outLen += n;
      i += n;
      if (this.outLen === FRAME) {
        const frame = this.out;
        this.port.postMessage(frame, [frame.buffer]);
        this.out = new Float32Array(FRAME);
        this.outLen = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
