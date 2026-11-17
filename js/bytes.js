// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Reading exact byte counts from a ReadableStream, and small helpers.

export class ByteReader {
  constructor(stream) {
    this.reader = stream.getReader();
    this.queue = [];
    this.head = 0;
    this.available = 0;
    this.ended = false;
  }

  async ensure(n) {
    while (this.available < n && !this.ended) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.ended = true;
        break;
      }
      if (value && value.byteLength) {
        const u8 =
          value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        this.queue.push(u8);
        this.available += u8.length;
      }
    }
    return this.available >= n;
  }

  // The next n bytes as a list of views into the stream's chunks (no copy).
  async readParts(n) {
    if (n === 0) return [];
    if (!(await this.ensure(n))) throw new Error("The image file ended too early: it is incomplete or damaged.");
    const parts = [];
    let left = n;
    while (left > 0) {
      const cur = this.queue[this.head];
      if (cur.length <= left) {
        parts.push(cur);
        this.queue[this.head++] = null;
        left -= cur.length;
      } else {
        parts.push(cur.subarray(0, left));
        this.queue[this.head] = cur.subarray(left);
        left = 0;
      }
    }
    if (this.head > 4096) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    this.available -= n;
    return parts;
  }

  async read(n) {
    const parts = await this.readParts(n);
    return parts.length === 1 ? parts[0] : concatBytes(parts, n);
  }

  async atEnd() {
    return !(await this.ensure(1));
  }

  async cancel() {
    try {
      await this.reader.cancel();
    } catch {
      // already closed or errored
    }
  }
}

// Yields the next `total` bytes of a reader in parts of at most `step` bytes.
export async function* readInParts(reader, total, step = 1 << 20) {
  let left = total;
  while (left > 0) {
    const n = Math.min(step, left);
    for (const p of await reader.readParts(n)) yield p;
    left -= n;
  }
}

export function concatBytes(parts, total) {
  if (total === undefined) total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatSize(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} bytes`;
}

// A TransformStream that passes data through and feeds it to `sink.update()`.
export function tap(sink) {
  return new TransformStream({
    transform(chunk, controller) {
      sink.update(chunk);
      controller.enqueue(chunk);
    },
  });
}
