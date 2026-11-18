// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// XZ decompression: the .xz container (format specification 1.2.1) with its LZMA2 filter,
// for the REPLACE_XZ operations of Android OTA payloads. It works on whole buffers: a
// payload compresses each operation (2 MiB of output at most) on its own. The LZMA decoder
// follows the structure of xz-embedded (public domain); this code is written for this page.

import { Crc32 } from "./crc32.js";
import { Sha256 } from "./sha256.js";
import { GrowableBytes } from "./bytes.js";

export class XzError extends Error {
  constructor(message) {
    super(`XZ data: ${message}`);
    this.name = "XzError";
  }
}
const corrupt = (what) => new XzError(what);

// ---------------------------------------------------------------- integrity checks

const CHECK_NONE = 0;
const CHECK_CRC32 = 1;
const CHECK_CRC64 = 4;
const CHECK_SHA256 = 10;
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

// CRC-64 as .xz uses it (ECMA-182 polynomial, reflected), in two 32-bit halves.
const CRC64_TABLE = (() => {
  const lo = new Uint32Array(256);
  const hi = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let l = n;
    let h = 0;
    for (let k = 0; k < 8; k++) {
      const carry = l & 1;
      l = ((l >>> 1) | (h << 31)) >>> 0;
      h >>>= 1;
      if (carry) {
        l = (l ^ 0xd7870f42) >>> 0;
        h = (h ^ 0xc96c5795) >>> 0;
      }
    }
    lo[n] = l;
    hi[n] = h;
  }
  return { lo, hi };
})();

// Returns [low 32 bits, high 32 bits].
export function crc64(data) {
  const { lo, hi } = CRC64_TABLE;
  let l = 0xffffffff;
  let h = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const t = (l ^ data[i]) & 0xff;
    l = (((l >>> 8) | (h << 24)) ^ lo[t]) >>> 0;
    h = ((h >>> 8) ^ hi[t]) >>> 0;
  }
  return [~l >>> 0, ~h >>> 0];
}

function verifyCheck(type, data, stored) {
  if (type === CHECK_NONE) return;
  const v = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
  if (type === CHECK_CRC32) {
    if (new Crc32().update(data).digest() !== v.getUint32(0, true)) throw corrupt("CRC-32 mismatch");
  } else if (type === CHECK_CRC64) {
    const [l, h] = crc64(data);
    if (l !== v.getUint32(0, true) || h !== v.getUint32(4, true)) throw corrupt("CRC-64 mismatch");
  } else if (type === CHECK_SHA256) {
    const d = new Sha256().update(data).digest();
    for (let i = 0; i < 32; i++) if (d[i] !== stored[i]) throw corrupt("SHA-256 mismatch");
  }
  // The remaining check types are reserved; the specification lets a decoder skip them.
}

// ---------------------------------------------------------------- LZMA

const STATES = 12;
const LIT_STATES = 7;
const POS_STATES_MAX = 16;
const MATCH_LEN_MIN = 2;
const DIST_STATES = 4;
const DIST_SLOTS = 64;
const DIST_MODEL_START = 4;
const DIST_MODEL_END = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;

// Offsets of the probability tables in one array.
const IS_MATCH = 0;
const IS_REP = IS_MATCH + STATES * POS_STATES_MAX;
const IS_REP0 = IS_REP + STATES;
const IS_REP1 = IS_REP0 + STATES;
const IS_REP2 = IS_REP1 + STATES;
const IS_REP0_LONG = IS_REP2 + STATES;
const DIST_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX;
const DIST_SPECIAL = DIST_SLOT + DIST_STATES * DIST_SLOTS;
const DIST_ALIGN = DIST_SPECIAL + FULL_DISTANCES - DIST_MODEL_END;
// A length coder: choice, choice2, low[16][8], mid[16][8], high[256].
const LEN_MID = 2 + POS_STATES_MAX * 8;
const LEN_HIGH = LEN_MID + POS_STATES_MAX * 8;
const LEN_CODER = LEN_HIGH + 256;
const MATCH_LEN = DIST_ALIGN + (1 << ALIGN_BITS);
const REP_LEN = MATCH_LEN + LEN_CODER;
const LITERAL = REP_LEN + LEN_CODER;
const PROBS = LITERAL + (0x300 << 4); // LZMA2 allows lc + lp <= 4

class LzmaDecoder {
  constructor() {
    this.probs = new Uint16Array(PROBS);
    this.lc = 0;
    this.lp = 0;
    this.pb = 0;
    this.input = null;
    this.pos = 0;
    this.end = 0;
    this.range = 0;
    this.code = 0;
    this.resetState();
  }

  setProps(byte) {
    if (byte >= 9 * 5 * 5) throw corrupt("invalid LZMA properties");
    const lc = byte % 9;
    const rest = (byte / 9) | 0;
    const lp = rest % 5;
    const pb = (rest / 5) | 0;
    if (lc + lp > 4) throw corrupt("invalid LZMA2 properties");
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.resetState();
  }

  resetState() {
    this.probs.fill(1024, 0, LITERAL + (0x300 << (this.lc + this.lp)));
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  // The range decoder is normalized before every bit, and once more at the end of a chunk.
  normalize() {
    if (this.range < 0x1000000) {
      if (this.pos >= this.end) throw corrupt("LZMA data ends early");
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.input[this.pos++]) >>> 0;
    }
  }

  bit(i) {
    this.normalize();
    const p = this.probs[i];
    const bound = (this.range >>> 11) * p;
    if (this.code < bound) {
      this.range = bound;
      this.probs[i] = p + ((2048 - p) >>> 5);
      return 0;
    }
    this.range -= bound;
    this.code -= bound;
    this.probs[i] = p - (p >>> 5);
    return 1;
  }

  bittree(base, limit) {
    let s = 1;
    do s = (s << 1) | this.bit(base + s);
    while (s < limit);
    return s - limit;
  }

  bittreeReverse(base, bits) {
    let s = 1;
    let r = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(base + s);
      s = (s << 1) | b;
      r |= b << i;
    }
    return r;
  }

  direct(bits) {
    let r = 0;
    for (; bits > 0; bits--) {
      this.normalize();
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      r = r * 2 + b;
    }
    return r;
  }

  len(base, posState) {
    if (!this.bit(base)) return MATCH_LEN_MIN + this.bittree(base + 2 + posState * 8, 8);
    if (!this.bit(base + 1)) return MATCH_LEN_MIN + 8 + this.bittree(base + LEN_MID + posState * 8, 8);
    return MATCH_LEN_MIN + 16 + this.bittree(base + LEN_HIGH, 256);
  }

  // Decodes one LZMA chunk of LZMA2, input[pos, end), into out[outPos, outEnd). The
  // dictionary was last reset at dictStart; distances must stay below dictSize.
  chunk(input, pos, end, out, outPos, outEnd, dictStart, dictSize) {
    if (end - pos < 5 || input[pos] !== 0) throw corrupt("bad LZMA chunk start");
    this.input = input;
    this.code = ((input[pos + 1] << 24) | (input[pos + 2] << 16) | (input[pos + 3] << 8) | input[pos + 4]) >>> 0;
    this.range = 0xffffffff;
    this.pos = pos + 5;
    this.end = end;
    const lc = this.lc;
    const lpMask = (1 << this.lp) - 1;
    const pbMask = (1 << this.pb) - 1;
    let state = this.state;
    let rep0 = this.rep0;
    let rep1 = this.rep1;
    let rep2 = this.rep2;
    let rep3 = this.rep3;
    while (outPos < outEnd) {
      const dpos = outPos - dictStart;
      const posState = dpos & pbMask;
      if (!this.bit(IS_MATCH + state * POS_STATES_MAX + posState)) {
        const prev = dpos > 0 ? out[outPos - 1] : 0;
        const base = LITERAL + 0x300 * (((dpos & lpMask) << lc) + (prev >>> (8 - lc)));
        let s = 1;
        if (state < LIT_STATES) {
          do s = (s << 1) | this.bit(base + s);
          while (s < 0x100);
        } else {
          // After a match, the byte at the match distance guides the probabilities.
          let matchByte = out[outPos - rep0 - 1] << 1;
          let offset = 0x100;
          do {
            const matchBit = matchByte & offset;
            matchByte <<= 1;
            const b = this.bit(base + offset + matchBit + s);
            s = (s << 1) | b;
            offset = b ? matchBit : offset & ~matchBit;
          } while (s < 0x100);
        }
        out[outPos++] = s & 0xff;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (this.bit(IS_REP + state)) {
        if (!this.bit(IS_REP0 + state)) {
          if (!this.bit(IS_REP0_LONG + state * POS_STATES_MAX + posState)) {
            // short rep: one byte from the last distance
            state = state < LIT_STATES ? 9 : 11;
            if (rep0 >= dpos) throw corrupt("distance beyond the data");
            out[outPos] = out[outPos - rep0 - 1];
            outPos++;
            continue;
          }
        } else {
          let dist;
          if (!this.bit(IS_REP1 + state)) {
            dist = rep1;
          } else {
            if (!this.bit(IS_REP2 + state)) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        state = state < LIT_STATES ? 8 : 11;
        len = this.len(REP_LEN, posState);
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = this.len(MATCH_LEN, posState);
        state = state < LIT_STATES ? 7 : 10;
        const distState = len < DIST_STATES + MATCH_LEN_MIN ? len - MATCH_LEN_MIN : DIST_STATES - 1;
        const slot = this.bittree(DIST_SLOT + distState * DIST_SLOTS, DIST_SLOTS);
        if (slot < DIST_MODEL_START) {
          rep0 = slot;
        } else {
          const bits = (slot >>> 1) - 1;
          let dist = (2 | (slot & 1)) * 2 ** bits;
          if (slot < DIST_MODEL_END) {
            dist += this.bittreeReverse(DIST_SPECIAL + dist - slot - 1, bits);
          } else {
            dist += this.direct(bits - ALIGN_BITS) * (1 << ALIGN_BITS);
            dist += this.bittreeReverse(DIST_ALIGN, ALIGN_BITS);
          }
          rep0 = dist;
        }
      }
      // Also catches the end-of-payload marker, which LZMA2 does not allow.
      if (rep0 >= dpos || rep0 >= dictSize) throw corrupt("distance beyond the data");
      if (outEnd - outPos < len) throw corrupt("match beyond the end of the chunk");
      let src = outPos - rep0 - 1;
      if (rep0 + 1 >= len) {
        out.copyWithin(outPos, src, src + len);
        outPos += len;
      } else {
        for (let k = 0; k < len; k++) out[outPos++] = out[src++];
      }
    }
    this.state = state;
    this.rep0 = rep0;
    this.rep1 = rep1;
    this.rep2 = rep2;
    this.rep3 = rep3;
    this.normalize();
    if (this.pos !== end || this.code !== 0) throw corrupt("LZMA chunk size mismatch");
    this.input = null;
  }
}

// ---------------------------------------------------------------- LZMA2

// Decodes LZMA2 data starting at input[pos] into out; returns the position after its end marker.
function lzma2(input, pos, out, dictSize) {
  const dec = new LzmaDecoder();
  let needDictReset = true;
  let needProps = true;
  let dictStart = out.length;
  for (;;) {
    if (pos >= input.length) throw corrupt("LZMA2 data ends early");
    const control = input[pos++];
    if (control === 0x00) return pos;
    if (control >= 0xe0 || control === 0x01) {
      needProps = true;
      needDictReset = false;
      dictStart = out.length;
    } else if (needDictReset) {
      throw corrupt("LZMA2 data does not start with a dictionary reset");
    }
    if (control >= 0x80) {
      if (pos + 4 > input.length) throw corrupt("LZMA2 data ends early");
      const unpacked = (control & 0x1f) * 65536 + (input[pos] << 8) + input[pos + 1] + 1;
      const packed = (input[pos + 2] << 8) + input[pos + 3] + 1;
      pos += 4;
      if (control >= 0xc0) {
        if (pos >= input.length) throw corrupt("LZMA2 data ends early");
        dec.setProps(input[pos++]);
        needProps = false;
      } else if (needProps) {
        throw corrupt("LZMA2 chunk without properties");
      } else if (control >= 0xa0) {
        dec.resetState();
      }
      if (pos + packed > input.length) throw corrupt("LZMA2 data ends early");
      const start = out.length;
      out.reserve(unpacked);
      dec.chunk(input, pos, pos + packed, out.buf, start, start + unpacked, dictStart, dictSize);
      out.length = start + unpacked;
      pos += packed;
    } else {
      if (control > 0x02) throw corrupt("invalid LZMA2 control byte");
      if (pos + 2 > input.length) throw corrupt("LZMA2 data ends early");
      const size = (input[pos] << 8) + input[pos + 1] + 1;
      pos += 2;
      if (pos + size > input.length) throw corrupt("LZMA2 data ends early");
      out.append(input.subarray(pos, pos + size));
      pos += size;
    }
  }
}

// ---------------------------------------------------------------- the .xz container

const HEADER_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

function u32le(b, i) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function crc32(b, start, end) {
  return new Crc32().update(b.subarray(start, end)).digest();
}

// A variable-length integer; returns [value, next position].
function varint(b, at) {
  let v = 0;
  let mul = 1;
  let i = at;
  for (let k = 0; k < 9; k++) {
    if (i >= b.length) throw corrupt("truncated integer");
    const c = b[i++];
    v += (c & 0x7f) * mul;
    if (!(c & 0x80)) {
      if (c === 0 && k > 0) throw corrupt("integer not minimally encoded");
      return [v, i];
    }
    mul *= 128;
  }
  throw corrupt("integer too long");
}

function decodeStream(input, pos, out) {
  if (pos + 12 > input.length) throw corrupt("stream header truncated");
  for (let i = 0; i < 6; i++) if (input[pos + i] !== HEADER_MAGIC[i]) throw corrupt("not an XZ stream");
  const flags0 = input[pos + 6];
  const flags1 = input[pos + 7];
  if (crc32(input, pos + 6, pos + 8) !== u32le(input, pos + 8)) throw corrupt("stream header damaged");
  if (flags0 !== 0 || flags1 & 0xf0) throw corrupt("unsupported stream flags");
  const checkType = flags1;
  const checkSize = CHECK_SIZES[checkType];
  pos += 12;

  const records = [];
  while (pos < input.length && input[pos] !== 0x00) {
    const blockStart = pos;
    const headerSize = (input[pos] + 1) * 4;
    if (pos + headerSize > input.length) throw corrupt("block header truncated");
    if (crc32(input, pos, pos + headerSize - 4) !== u32le(input, pos + headerSize - 4)) {
      throw corrupt("block header damaged");
    }
    const bflags = input[pos + 1];
    if (bflags & 0x3c) throw corrupt("unsupported block flags");
    let p = pos + 2;
    let compressed = -1;
    let uncompressed = -1;
    if (bflags & 0x40) [compressed, p] = varint(input, p);
    if (bflags & 0x80) [uncompressed, p] = varint(input, p);
    const filters = (bflags & 0x03) + 1;
    let dictSize = 0;
    for (let f = 0; f < filters; f++) {
      let id;
      let size;
      [id, p] = varint(input, p);
      [size, p] = varint(input, p);
      if (id !== 0x21 || filters !== 1 || size !== 1) {
        throw corrupt(`filter 0x${id.toString(16)} is not supported (only LZMA2 is)`);
      }
      const d = input[p++];
      if (d > 40) throw corrupt("invalid LZMA2 dictionary size");
      dictSize = d === 40 ? 0xffffffff : (2 | (d & 1)) * 2 ** ((d >>> 1) + 11);
    }
    const headerEnd = pos + headerSize - 4;
    if (p > headerEnd) throw corrupt("block header too short");
    for (; p < headerEnd; p++) if (input[p] !== 0) throw corrupt("block header padding not zero");

    const dataStart = pos + headerSize;
    const outStart = out.length;
    const dataEnd = lzma2(input, dataStart, out, dictSize);
    const csize = dataEnd - dataStart;
    const usize = out.length - outStart;
    if ((compressed >= 0 && compressed !== csize) || (uncompressed >= 0 && uncompressed !== usize)) {
      throw corrupt("block size does not match its header");
    }
    pos = dataEnd;
    while ((pos - blockStart) % 4) {
      if (input[pos] !== 0) throw corrupt("block padding not zero");
      pos++;
    }
    if (pos + checkSize > input.length) throw corrupt("block check truncated");
    verifyCheck(checkType, out.buf.subarray(outStart, out.length), input.subarray(pos, pos + checkSize));
    pos += checkSize;
    records.push([headerSize + csize + checkSize, usize]);
  }

  // Index: the list of block sizes, which has to match what was decoded.
  const indexStart = pos;
  if (pos >= input.length) throw corrupt("index missing");
  pos++;
  let count;
  [count, pos] = varint(input, pos);
  if (count !== records.length) throw corrupt("index does not match the blocks");
  for (const [unpadded, usize] of records) {
    let a;
    let b;
    [a, pos] = varint(input, pos);
    [b, pos] = varint(input, pos);
    if (a !== unpadded || b !== usize) throw corrupt("index does not match the blocks");
  }
  while ((pos - indexStart) % 4) {
    if (input[pos] !== 0) throw corrupt("index padding not zero");
    pos++;
  }
  if (pos + 4 > input.length || crc32(input, indexStart, pos) !== u32le(input, pos)) throw corrupt("index damaged");
  pos += 4;
  const indexSize = pos - indexStart;

  if (pos + 12 > input.length) throw corrupt("stream footer missing");
  if (crc32(input, pos + 4, pos + 10) !== u32le(input, pos)) throw corrupt("stream footer damaged");
  if ((u32le(input, pos + 4) + 1) * 4 !== indexSize) throw corrupt("stream footer does not match the index");
  if (input[pos + 8] !== flags0 || input[pos + 9] !== flags1 || input[pos + 10] !== 0x59 || input[pos + 11] !== 0x5a) {
    throw corrupt("stream footer damaged");
  }
  return pos + 12;
}

// Decompresses a complete .xz file (one or more streams). maxSize: the most output allowed,
// which is also used as the initial buffer size.
export function xzDecompress(input, maxSize = Infinity) {
  const out = new GrowableBytes(Number.isFinite(maxSize) ? maxSize : Math.max(65536, input.length * 4));
  let pos = 0;
  let streams = 0;
  while (pos < input.length) {
    if (streams > 0) {
      const z = pos;
      while (pos < input.length && input[pos] === 0) pos++;
      if ((pos - z) % 4) throw corrupt("stream padding is not a multiple of four bytes");
      if (pos === input.length) break;
    }
    pos = decodeStream(input, pos, out);
    streams++;
    if (out.length > maxSize) throw corrupt(`more than ${maxSize} bytes`);
  }
  if (!streams) throw corrupt("empty input");
  return out.bytes();
}
