// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Android sparse images: header parsing, and splitting one image into several
// sparse images that each fit into one fastboot download.
//
// The split follows libsparse's sparse_file_resparse() (system/core/libsparse/sparse.cpp),
// which host fastboot uses when an image is larger than the download limit: every piece is
// a complete sparse image of the full partition size, holding a run of the input's data
// chunks with DONT_CARE chunks for everything else, and a data chunk that does not fit is
// split at a block boundary. It works on a stream, so only one piece is held in memory.

import { Sha256 } from "./sha256.js";

export const SPARSE_MAGIC = 0xed26ff3a;
export const CHUNK_RAW = 0xcac1;
export const CHUNK_FILL = 0xcac2;
export const CHUNK_DONT_CARE = 0xcac3;
export const CHUNK_CRC32 = 0xcac4;

const FILE_HEADER = 28;
const CHUNK_HEADER = 12;

function viewOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

// The header of a sparse image, or null if `bytes` does not start one.
export function parseSparseHeader(bytes) {
  if (bytes.length < FILE_HEADER) return null;
  const v = viewOf(bytes);
  if (v.getUint32(0, true) !== SPARSE_MAGIC) return null;
  const h = {
    major: v.getUint16(4, true),
    minor: v.getUint16(6, true),
    fileHeaderSize: v.getUint16(8, true),
    chunkHeaderSize: v.getUint16(10, true),
    blockSize: v.getUint32(12, true),
    totalBlocks: v.getUint32(16, true),
    totalChunks: v.getUint32(20, true),
  };
  if (
    h.major !== 1 ||
    h.fileHeaderSize < FILE_HEADER ||
    h.chunkHeaderSize < CHUNK_HEADER ||
    h.blockSize === 0 ||
    h.blockSize % 4 !== 0
  ) {
    throw new Error("The sparse image header is not supported.");
  }
  return h;
}

function fileHeader(blockSize, totalBlocks, chunks) {
  const b = new Uint8Array(FILE_HEADER);
  const v = viewOf(b);
  v.setUint32(0, SPARSE_MAGIC, true);
  v.setUint16(4, 1, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, FILE_HEADER, true);
  v.setUint16(10, CHUNK_HEADER, true);
  v.setUint32(12, blockSize, true);
  v.setUint32(16, totalBlocks, true);
  v.setUint32(20, chunks, true);
  v.setUint32(24, 0, true);
  return b;
}

function chunkHeader(type, blocks, totalSize) {
  const b = new Uint8Array(CHUNK_HEADER);
  const v = viewOf(b);
  v.setUint16(0, type, true);
  v.setUint32(4, blocks, true);
  v.setUint32(8, totalSize, true);
  return b;
}

// Data chunks of a sparse image, read from `reader` (positioned after the file header).
// RAW chunks are yielded before their data is read: the consumer reads it from `reader`.
async function* sparseChunks(reader, h) {
  let pos = 0;
  for (let i = 0; i < h.totalChunks; i++) {
    const hdr = await reader.read(h.chunkHeaderSize);
    const v = viewOf(hdr);
    const type = v.getUint16(0, true);
    const blocks = v.getUint32(4, true);
    const payload = v.getUint32(8, true) - h.chunkHeaderSize;
    const bad = () => new Error(`The sparse image is damaged (chunk ${i + 1}).`);
    if (type === CHUNK_RAW) {
      if (payload !== blocks * h.blockSize) throw bad();
      yield { type, start: pos, blocks };
      pos += blocks;
    } else if (type === CHUNK_FILL) {
      if (payload !== 4) throw bad();
      const value = (await reader.read(4)).slice();
      yield { type, start: pos, blocks, value };
      pos += blocks;
    } else if (type === CHUNK_DONT_CARE) {
      if (payload !== 0) throw bad();
      pos += blocks;
    } else if (type === CHUNK_CRC32) {
      if (payload !== 4) throw bad();
      await reader.read(4);
    } else {
      throw new Error(`The sparse image has an unknown chunk type 0x${type.toString(16)}.`);
    }
    if (pos > h.totalBlocks) throw bad();
  }
  if (pos !== h.totalBlocks) {
    throw new Error(`The sparse image covers ${pos} of its ${h.totalBlocks} blocks.`);
  }
}

// A raw (non-sparse) image of `size` bytes as one RAW chunk, for splitting it like
// host fastboot does (fastboot/util.cpp split_file()).
export function rawImageLayout(size) {
  const blockSize = size % 4096 === 0 ? 4096 : size % 512 === 0 ? 512 : 0;
  if (!blockSize) throw new Error("The image is too large for one download and its size is not block aligned.");
  return { blockSize, totalBlocks: size / blockSize, raw: true };
}

async function* rawChunks(h) {
  yield { type: CHUNK_RAW, start: 0, blocks: h.totalBlocks };
}

// Splits an image into sparse pieces of at most maxSize bytes.
// `h` is the input's sparse header (reader positioned after it), or rawImageLayout().
// Yields { parts: Uint8Array[], size, firstBlock, endBlock }.
export async function* splitSparse(reader, h, maxSize) {
  const bs = h.blockSize;
  // Room for chunks, keeping space for the file header and a trailing DONT_CARE chunk.
  const budget = maxSize - FILE_HEADER - CHUNK_HEADER;
  if (budget < 2 * CHUNK_HEADER + bs) throw new Error("The download limit is too small.");

  const chunks = h.raw ? rawChunks(h) : sparseChunks(reader, h);
  let piece = { items: [], used: 0, end: 0 };
  let pending = null;
  let emitted = 0;

  const gapCost = (start) => (start > piece.end ? CHUNK_HEADER : 0);
  const emit = () => {
    const out = buildPiece(piece.items, bs, h.totalBlocks);
    if (out.size > maxSize) throw new Error("Internal error: sparse piece too large.");
    emitted++;
    piece = { items: [], used: 0, end: 0 };
    return out;
  };

  for (;;) {
    let item = pending;
    pending = null;
    if (!item) {
      const next = await chunks.next();
      if (next.done) break;
      item = next.value;
    }

    if (item.type === CHUNK_FILL) {
      if (piece.used + gapCost(item.start) + CHUNK_HEADER + 4 > budget) yield emit();
      piece.used += gapCost(item.start) + CHUNK_HEADER + 4;
      piece.items.push(item);
      piece.end = item.start + item.blocks;
      continue;
    }

    // RAW
    const gap = gapCost(item.start);
    if (piece.used + gap + CHUNK_HEADER + item.blocks * bs <= budget) {
      item.parts = await reader.readParts(item.blocks * bs);
      piece.used += gap + CHUNK_HEADER + item.blocks * bs;
      piece.items.push(item);
      piece.end = item.start + item.blocks;
      continue;
    }
    // It does not fit. Like libsparse, split it if the piece is empty or more than an
    // eighth of the budget is left; otherwise start the next piece with it.
    const room = budget - piece.used - gap - CHUNK_HEADER;
    const fit = Math.floor(room / bs);
    if (fit >= 1 && (piece.items.length === 0 || room > budget / 8)) {
      const head = { type: CHUNK_RAW, start: item.start, blocks: fit };
      head.parts = await reader.readParts(fit * bs);
      piece.used += gap + CHUNK_HEADER + fit * bs;
      piece.items.push(head);
      piece.end = head.start + fit;
      pending = { type: CHUNK_RAW, start: item.start + fit, blocks: item.blocks - fit };
    } else {
      if (piece.items.length === 0) throw new Error("The download limit is too small.");
      pending = item;
    }
    yield emit();
  }
  if (piece.items.length > 0 || emitted === 0) yield emit();
}

function buildPiece(items, bs, totalBlocks) {
  const body = [];
  let chunks = 0;
  let cursor = 0;
  for (const it of items) {
    if (it.start > cursor) {
      body.push(chunkHeader(CHUNK_DONT_CARE, it.start - cursor, CHUNK_HEADER));
      chunks++;
    }
    if (it.type === CHUNK_RAW) {
      body.push(chunkHeader(CHUNK_RAW, it.blocks, CHUNK_HEADER + it.blocks * bs));
      for (const p of it.parts) body.push(p);
    } else {
      body.push(chunkHeader(CHUNK_FILL, it.blocks, CHUNK_HEADER + 4));
      body.push(it.value);
    }
    chunks++;
    cursor = it.start + it.blocks;
  }
  if (cursor < totalBlocks) {
    body.push(chunkHeader(CHUNK_DONT_CARE, totalBlocks - cursor, CHUNK_HEADER));
    chunks++;
  }
  const parts = [fileHeader(bs, totalBlocks, chunks), ...body];
  let size = 0;
  for (const p of parts) size += p.length;
  return { parts, size, firstBlock: items.length ? items[0].start : 0, endBlock: cursor };
}

// Content digest of what a sparse image writes, independent of how it is chunked or
// split: SHA-256 over (block number as 8 bytes little-endian, block data) for every
// written block in ascending order. tools/sparse_digest.py computes the same in Python.
// Used by the tests and the simulated phone.
export class BlockDigest {
  constructor(blockSize) {
    this.blockSize = blockSize;
    this.sha = new Sha256();
    this.next = 0;
    this.blocks = 0;
    this.index = new Uint8Array(8);
    this.indexView = new DataView(this.index.buffer);
  }

  startBlock(n) {
    if (n < this.next) throw new Error(`blocks written out of order (block ${n} after ${this.next})`);
    this.indexView.setUint32(0, n % 0x100000000, true);
    this.indexView.setUint32(4, Math.floor(n / 0x100000000), true);
    this.sha.update(this.index);
    this.next = n + 1;
    this.blocks++;
  }

  // Applies one complete sparse image held in `data`.
  applySparse(data) {
    const h = parseSparseHeader(data);
    if (!h) throw new Error("not a sparse image");
    if (h.blockSize !== this.blockSize) throw new Error("block size mismatch");
    const v = viewOf(data);
    let off = h.fileHeaderSize;
    let pos = 0;
    for (let i = 0; i < h.totalChunks; i++) {
      if (off + h.chunkHeaderSize > data.length) throw new Error("sparse image truncated");
      const type = v.getUint16(off, true);
      const blocks = v.getUint32(off + 4, true);
      const total = v.getUint32(off + 8, true);
      const body = off + h.chunkHeaderSize;
      if (type === CHUNK_RAW) {
        if (total - h.chunkHeaderSize !== blocks * h.blockSize) throw new Error("bad RAW chunk");
        for (let b = 0; b < blocks; b++) {
          this.startBlock(pos + b);
          this.sha.update(data.subarray(body + b * h.blockSize, body + (b + 1) * h.blockSize));
        }
      } else if (type === CHUNK_FILL) {
        if (total - h.chunkHeaderSize !== 4) throw new Error("bad FILL chunk");
        const block = new Uint8Array(h.blockSize);
        for (let k = 0; k < h.blockSize; k += 4) block.set(data.subarray(body, body + 4), k);
        for (let b = 0; b < blocks; b++) {
          this.startBlock(pos + b);
          this.sha.update(block);
        }
      } else if (type === CHUNK_DONT_CARE) {
        if (total !== h.chunkHeaderSize) throw new Error("bad DONT_CARE chunk");
      } else if (type === CHUNK_CRC32) {
        if (total - h.chunkHeaderSize !== 4) throw new Error("bad CRC32 chunk");
      } else {
        throw new Error(`unknown chunk type ${type}`);
      }
      if (type !== CHUNK_CRC32) pos += blocks;
      off += total;
    }
    if (pos !== h.totalBlocks) throw new Error(`sparse image covers ${pos} of ${h.totalBlocks} blocks`);
    if (off !== data.length) throw new Error("trailing data after the last chunk");
    return h;
  }

  hex() {
    return this.sha.hex();
  }
}
