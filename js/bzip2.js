// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// bzip2 decompression, for the REPLACE_BZ operations of Android OTA payloads. It works on
// whole buffers. Written for this page from the format as libbzip2 1.0 writes and checks it:
// Huffman-coded move-to-front symbols with zero runs, the Burrows-Wheeler transform, and the
// initial run-length coding, each block with its CRC.

import { GrowableBytes } from "./bytes.js";

export class Bzip2Error extends Error {
  constructor(message) {
    super(`bzip2 data: ${message}`);
    this.name = "Bzip2Error";
  }
}
const corrupt = (what) => new Bzip2Error(what);

// CRC-32 as bzip2 computes it: most significant bit first, polynomial 0x04c11db7.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const MAX_GROUPS = 6;
const MAX_ALPHA = 258;
const MAX_CODE_LEN = 20;
const MAX_SELECTORS = 18002;
const GROUP_SIZE = 50;

class Bits {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.acc = 0; // the next `n` bits, most significant first
    this.n = 0;
  }

  get(count) {
    // count <= 24, so `acc` never needs more than 31 bits.
    while (this.n < count) {
      if (this.pos >= this.buf.length) throw corrupt("ends early");
      this.acc = (this.acc << 8) | this.buf[this.pos++];
      this.n += 8;
    }
    this.n -= count;
    const v = (this.acc >>> this.n) & ((1 << count) - 1);
    this.acc &= (1 << this.n) - 1;
    return v;
  }

  u32() {
    return this.get(16) * 65536 + this.get(16);
  }

  // Skips to the next byte boundary and gives back whole bytes read ahead.
  align() {
    this.n -= this.n % 8;
    this.pos -= this.n / 8;
    this.n = 0;
    this.acc = 0;
  }

  get atEnd() {
    return this.n === 0 && this.pos >= this.buf.length;
  }

  symbol(t) {
    let zn = t.minLen;
    let zv = this.get(zn);
    for (;;) {
      if (zn > MAX_CODE_LEN) throw corrupt("bad Huffman code");
      if (zv <= t.limit[zn]) break;
      zn++;
      zv = (zv << 1) | this.get(1);
    }
    const i = zv - t.base[zn];
    if (i < 0 || i >= MAX_ALPHA) throw corrupt("bad Huffman code");
    return t.perm[i];
  }
}

// Canonical Huffman decoding tables, as libbzip2 builds them (limit, base and perm).
function huffmanTable(lengths, alphaSize) {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] < minLen) minLen = lengths[i];
    if (lengths[i] > maxLen) maxLen = lengths[i];
  }
  const perm = new Int32Array(MAX_ALPHA);
  const base = new Int32Array(MAX_CODE_LEN + 3);
  const limit = new Int32Array(MAX_CODE_LEN + 3);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let j = 0; j < alphaSize; j++) if (lengths[j] === len) perm[pp++] = j;
  }
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len];
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len++) base[len] = ((limit[len - 1] + 1) << 1) - base[len];
  return { minLen, perm, base, limit };
}

// One block: appends its output to `out` and returns its CRC. `tt` has room for maxBlock.
function decodeBlock(bits, maxBlock, tt, out) {
  if (bits.get(1)) throw corrupt("randomised blocks are not supported");
  const origPtr = bits.get(24);

  // The bytes that occur in the block.
  const used = bits.get(16);
  const seqToUnseq = new Uint8Array(256);
  let nInUse = 0;
  for (let i = 0; i < 16; i++) {
    if (used & (0x8000 >>> i)) {
      const v = bits.get(16);
      for (let j = 0; j < 16; j++) if (v & (0x8000 >>> j)) seqToUnseq[nInUse++] = i * 16 + j;
    }
  }
  if (nInUse === 0) throw corrupt("block uses no symbols");
  const alphaSize = nInUse + 2;

  // Which Huffman table each group of 50 symbols uses (move-to-front coded).
  const nGroups = bits.get(3);
  if (nGroups < 2 || nGroups > MAX_GROUPS) throw corrupt("bad number of Huffman tables");
  let nSelectors = bits.get(15);
  if (nSelectors < 1) throw corrupt("no selectors");
  const selectorMtf = new Uint8Array(Math.min(nSelectors, MAX_SELECTORS));
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (bits.get(1)) {
      j++;
      if (j >= nGroups) throw corrupt("bad selector");
    }
    if (i < MAX_SELECTORS) selectorMtf[i] = j;
  }
  nSelectors = Math.min(nSelectors, MAX_SELECTORS);
  const order = [0, 1, 2, 3, 4, 5];
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let v = selectorMtf[i];
    const t = order[v];
    for (; v > 0; v--) order[v] = order[v - 1];
    order[0] = t;
    selectors[i] = t;
  }

  // The Huffman tables, as delta-coded code lengths.
  const tables = [];
  const lengths = new Uint8Array(MAX_ALPHA);
  for (let t = 0; t < nGroups; t++) {
    let curr = bits.get(5);
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (curr < 1 || curr > MAX_CODE_LEN) throw corrupt("bad code length");
        if (!bits.get(1)) break;
        curr += bits.get(1) ? -1 : 1;
      }
      lengths[i] = curr;
    }
    tables.push(huffmanTable(lengths, alphaSize));
  }

  // Move-to-front values, with runs of the front value as RUNA/RUNB digits.
  const EOB = nInUse + 1;
  const unzftab = new Int32Array(256);
  const mtf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) mtf[i] = i;
  let nblock = 0;
  let group = -1;
  let groupLeft = 0;
  let table = null;
  let run = 0;
  let weight = 0; // 0: not in a run
  for (;;) {
    if (groupLeft === 0) {
      if (++group >= nSelectors) throw corrupt("more symbols than selectors");
      groupLeft = GROUP_SIZE;
      table = tables[selectors[group]];
    }
    groupLeft--;
    const sym = bits.symbol(table);
    if (sym <= 1) {
      if (weight === 0) {
        weight = 1;
        run = 0;
      }
      if (weight >= 2 * 1024 * 1024) throw corrupt("run too long");
      run += (sym + 1) * weight;
      weight *= 2;
      continue;
    }
    if (weight) {
      const uc = seqToUnseq[mtf[0]];
      if (nblock + run > maxBlock) throw corrupt("block too long");
      unzftab[uc] += run;
      tt.fill(uc, nblock, nblock + run);
      nblock += run;
      weight = 0;
    }
    if (sym === EOB) break;
    if (nblock >= maxBlock) throw corrupt("block too long");
    const idx = sym - 1;
    const v = mtf[idx];
    mtf.copyWithin(1, 0, idx);
    mtf[0] = v;
    const uc = seqToUnseq[v];
    unzftab[uc]++;
    tt[nblock++] = uc;
  }
  if (origPtr >= nblock) throw corrupt("bad origin pointer");

  // Inverse Burrows-Wheeler transform: each entry of tt gets the index of its successor.
  const cftab = new Int32Array(257);
  for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
  for (let i = 0; i < nblock; i++) {
    const uc = tt[i] & 0xff;
    tt[cftab[uc]++] |= i << 8;
  }

  // Output, undoing the initial run-length coding: four equal bytes and a repeat count.
  out.reserve(nblock);
  let buf = out.buf;
  let o = out.length;
  let crc = 0xffffffff;
  let tPos = tt[origPtr] >>> 8;
  let last = -1;
  let count = 0;
  for (let i = 0; i < nblock; i++) {
    tPos = tt[tPos];
    const b = tPos & 0xff;
    tPos >>>= 8;
    if (count === 4) {
      if (b) {
        out.length = o;
        out.reserve(b + nblock - i);
        buf = out.buf;
        buf.fill(last, o, o + b);
        o += b;
        for (let k = 0; k < b; k++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ last) & 0xff]) >>> 0;
      }
      count = 0;
      last = -1;
      continue;
    }
    if (b === last) {
      count++;
    } else {
      last = b;
      count = 1;
    }
    buf[o++] = b;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  }
  out.length = o;
  return ~crc >>> 0;
}

// Decompresses complete bzip2 data (one or more streams). maxSize: the most output allowed,
// which is also used as the initial buffer size.
export function bzip2Decompress(input, maxSize = Infinity) {
  const out = new GrowableBytes(Number.isFinite(maxSize) ? maxSize : Math.max(65536, input.length * 8));
  const bits = new Bits(input);
  let streams = 0;
  let tt = null;
  while (!bits.atEnd) {
    if (bits.get(8) !== 0x42 || bits.get(8) !== 0x5a || bits.get(8) !== 0x68) {
      throw corrupt(streams ? "unexpected data after the end" : "not bzip2 data");
    }
    const level = bits.get(8) - 0x30;
    if (level < 1 || level > 9) throw corrupt("bad block size");
    const maxBlock = level * 100000;
    if (!tt || tt.length < maxBlock) tt = new Uint32Array(maxBlock);
    let combined = 0;
    for (;;) {
      const m1 = bits.get(24);
      const m2 = bits.get(24);
      if (m1 === 0x177245 && m2 === 0x385090) {
        if (bits.u32() !== combined) throw corrupt("stream checksum mismatch");
        bits.align();
        break;
      }
      if (m1 !== 0x314159 || m2 !== 0x265359) throw corrupt("bad block header");
      const stored = bits.u32();
      const crc = decodeBlock(bits, maxBlock, tt, out);
      if (crc !== stored) throw corrupt("block checksum mismatch");
      combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
      if (out.length > maxSize) throw corrupt(`more than ${maxSize} bytes`);
    }
    streams++;
  }
  if (!streams) throw corrupt("empty input");
  return out.bytes();
}
