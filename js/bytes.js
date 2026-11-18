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

// A byte buffer that grows as data is appended (the decompressors' output).
export class GrowableBytes {
  constructor(capacity = 65536) {
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.length = 0;
  }

  // Makes room for n more bytes. this.buf may be replaced.
  reserve(n) {
    const need = this.length + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.length));
    this.buf = b;
  }

  append(bytes) {
    this.reserve(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  bytes() {
    return this.buf.subarray(0, this.length);
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

// Long computations call this between steps: about every 50 ms it lets the browser draw and
// handle events and timers. (An await on data that is already there does not.) It waits for
// a message on a channel: a timeout would be slowed to one a second or less while the tab is
// hidden, and scheduler.yield() resumes ahead of the page's timers, which then wait until the
// computation ends.
const channel = typeof MessageChannel === "function" ? new MessageChannel() : null;
const waiting = [];
if (channel) channel.port1.onmessage = () => waiting.shift()();
let lastYield = 0;
export async function yieldNow() {
  const now = performance.now();
  if (now - lastYield < 50) return;
  await new Promise((resolve) => {
    if (!channel) return setTimeout(resolve, 0);
    waiting.push(resolve);
    channel.port2.postMessage(null);
  });
  lastYield = performance.now();
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
