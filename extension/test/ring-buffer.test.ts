import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../src/lib/ring-buffer';
import { Downsampler } from '../src/lib/resample';
import { rms, arrayBufferToBase64, base64ToBytes } from '../src/lib/audio';

const seq = (from: number, n: number) => Float32Array.from({ length: n }, (_, i) => from + i);

describe('RingBuffer', () => {
  it('returns what was pushed before it fills', () => {
    const rb = new RingBuffer(10);
    rb.push(seq(1, 4));
    expect(rb.length).toBe(4);
    expect([...rb.latest(10)]).toEqual([1, 2, 3, 4]);
    expect([...rb.latest(2)]).toEqual([3, 4]);
  });

  it('keeps only the newest samples once it wraps', () => {
    const rb = new RingBuffer(5);
    rb.push(seq(1, 3));
    rb.push(seq(4, 4)); // 1..7, capacity 5 → 3..7
    expect(rb.length).toBe(5);
    expect([...rb.latest(5)]).toEqual([3, 4, 5, 6, 7]);
    expect([...rb.latest(3)]).toEqual([5, 6, 7]);
  });

  it('slices across the wrap point in chronological order', () => {
    const rb = new RingBuffer(6);
    for (let i = 0; i < 5; i++) rb.push(seq(i * 4, 4)); // 0..19
    expect([...rb.latest(6)]).toEqual([14, 15, 16, 17, 18, 19]);
  });

  it('handles a frame larger than the capacity', () => {
    const rb = new RingBuffer(4);
    rb.push(seq(0, 10));
    expect([...rb.latest(4)]).toEqual([6, 7, 8, 9]);
  });

  it('clamps requests and clears', () => {
    const rb = new RingBuffer(4);
    rb.push(seq(0, 2));
    expect(rb.latest(100).length).toBe(2);
    expect(rb.latest(0).length).toBe(0);
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.latest(4).length).toBe(0);
  });

  it('holds 25s at 16 kHz and slices the last 12s', () => {
    const rb = new RingBuffer(16000 * 25);
    for (let s = 0; s < 40; s++) rb.push(new Float32Array(16000).fill(s)); // 40 one-second frames
    const clip = rb.latest(16000 * 12);
    expect(clip.length).toBe(16000 * 12);
    expect(clip[0]).toBe(28);
    expect(clip[clip.length - 1]).toBe(39);
  });
});

describe('Downsampler', () => {
  it('turns 48 kHz stereo into 16 kHz mono', () => {
    const ds = new Downsampler(48000);
    const left = new Float32Array(480).fill(0.5);
    const right = new Float32Array(480).fill(-0.1);
    const out = ds.process([left, right]);
    expect(out.length).toBe(160);
    expect(out[0]).toBeCloseTo(0.2);
  });

  it('keeps fractional position across calls (44.1 kHz)', () => {
    const ds = new Downsampler(44100);
    let total = 0;
    for (let i = 0; i < 441; i++) total += ds.process([new Float32Array(128)]).length;
    expect(Math.abs(total - (441 * 128 * 16000) / 44100)).toBeLessThanOrEqual(1);
  });
});

describe('audio helpers', () => {
  it('computes RMS', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('round-trips base64', () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);
    expect([...base64ToBytes(arrayBufferToBase64(bytes.buffer))]).toEqual([...bytes]);
  });
});
