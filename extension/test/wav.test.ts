import { describe, expect, it } from 'vitest';
import { encodeWav } from '../src/lib/wav';

const ascii = (view: DataView, offset: number, len: number) =>
  String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(offset + i)));

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header', () => {
    const buf = encodeWav(new Float32Array(16000), 16000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 32000);
    expect(ascii(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 32000);
    expect(ascii(v, 8, 4)).toBe('WAVE');
    expect(ascii(v, 12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(v, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(32000);
  });

  it('converts and clamps samples', () => {
    const v = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2]), 16000));
    const s = (i: number) => v.getInt16(44 + i * 2, true);
    expect(s(0)).toBe(0);
    expect(s(1)).toBe(32767);
    expect(s(2)).toBe(-32768);
    expect(s(3)).toBe(16383);
    expect(s(4)).toBe(32767);
    expect(s(5)).toBe(-32768);
  });

  it('handles an empty clip', () => {
    expect(encodeWav(new Float32Array(0), 16000).byteLength).toBe(44);
  });
});
