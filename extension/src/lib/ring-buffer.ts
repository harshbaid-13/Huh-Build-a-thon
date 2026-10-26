/** Fixed-capacity Float32 ring buffer holding the most recent samples. */
export class RingBuffer {
  private buf: Float32Array;
  private writePos = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  /** Number of samples currently stored (≤ capacity). */
  get length(): number {
    return this.filled;
  }

  push(frame: Float32Array): void {
    let src = frame;
    // Only the newest `capacity` samples of an oversized frame can survive.
    if (src.length > this.capacity) src = src.subarray(src.length - this.capacity);
    const first = Math.min(src.length, this.capacity - this.writePos);
    this.buf.set(src.subarray(0, first), this.writePos);
    if (first < src.length) this.buf.set(src.subarray(first), 0);
    this.writePos = (this.writePos + src.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + src.length);
  }

  /** Copy of the newest `n` samples in chronological order (fewer if not yet filled). */
  latest(n: number): Float32Array {
    const count = Math.max(0, Math.min(n, this.filled));
    const out = new Float32Array(count);
    const start = (this.writePos - count + this.capacity) % this.capacity;
    const first = Math.min(count, this.capacity - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < count) out.set(this.buf.subarray(0, count - first), first);
    return out;
  }

  clear(): void {
    this.writePos = 0;
    this.filled = 0;
  }
}
