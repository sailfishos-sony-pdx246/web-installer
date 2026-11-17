// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Streaming SHA-256 (FIPS 180-4). WebCrypto can only hash a whole buffer at once,
// which would need the complete image zip in memory; this one takes it in pieces.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Int32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.w = new Int32Array(64);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.length = 0;
  }

  update(data) {
    const n = data.length;
    let i = 0;
    this.length += n;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen < 64) return this;
      this.compress(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= n; i += 64) this.compress(data, i);
    if (i < n) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = n - i;
    }
    return this;
  }

  compress(d, o) {
    const w = this.w;
    const h = this.h;
    for (let j = 0; j < 16; j++, o += 4) {
      w[j] = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
    }
    for (let j = 16; j < 64; j++) {
      const x = w[j - 15];
      const y = w[j - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d3 = h[3], e = h[4], f = h[5], g = h[6], h7 = h[7];
    for (let j = 0; j < 64; j++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h7 + S1 + ch + K[j] + w[j]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h7 = g;
      g = f;
      f = e;
      e = (d3 + t1) | 0;
      d3 = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d3;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += h7;
  }

  digest() {
    const bytes = this.length;
    const pad = new Uint8Array((this.bufLen < 56 ? 64 : 128) - this.bufLen);
    pad[0] = 0x80;
    const pv = new DataView(pad.buffer);
    // Length in bits as a 64-bit big-endian number; bytes * 8 can exceed 2^32.
    pv.setUint32(pad.length - 8, Math.floor(bytes / 0x20000000));
    pv.setUint32(pad.length - 4, (bytes % 0x20000000) * 8);
    this.update(pad);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let j = 0; j < 8; j++) ov.setInt32(j * 4, this.h[j]);
    return out;
  }

  hex() {
    return toHex(this.digest());
  }
}

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
