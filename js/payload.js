// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Android A/B OTA packages: payload.bin inside the zip, read in place (format "CrAU", see
// system/update_engine/update_metadata.proto). A full payload holds every partition as a
// list of operations on 4 KiB blocks (REPLACE, REPLACE_BZ, REPLACE_XZ, ZERO), with the
// SHA-256 of each operation's data and of each finished partition. This module checks all
// of them, and turns a partition into the chunks of a sparse image for fastboot: blocks
// that repeat one 4-byte value (the zeros of a partition's free space) become FILL chunks,
// so that they are not sent over USB.

import { ZipFile } from "./zip.js";
import { Sha256, toHex } from "./sha256.js";
import { xzDecompress } from "./xz.js";
import { bzip2Decompress } from "./bzip2.js";
import { CHUNK_RAW, CHUNK_FILL } from "./sparse.js";
import { yieldNow } from "./bytes.js";

export const OP_REPLACE = 0;
export const OP_REPLACE_BZ = 1;
export const OP_ZERO = 6;
export const OP_DISCARD = 7;
export const OP_REPLACE_XZ = 8;
const OP_NAMES = [
  "REPLACE", "REPLACE_BZ", "MOVE", "BSDIFF", "SOURCE_COPY", "SOURCE_BSDIFF", "ZERO", "DISCARD", "REPLACE_XZ",
  "PUFFDIFF", "BROTLI_BSDIFF", "ZUCCHINI", "LZ4DIFF_BSDIFF", "LZ4DIFF_PUFFDIFF",
];
const SUPPORTED = new Set([OP_REPLACE, OP_REPLACE_BZ, OP_ZERO, OP_DISCARD, OP_REPLACE_XZ]);
const hasData = (op) => op.type === OP_REPLACE || op.type === OP_REPLACE_BZ || op.type === OP_REPLACE_XZ;

export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadError";
  }
}

// ---------------------------------------------------------------- protobuf (proto2 wire format)

// Varints beyond 2^53 lose precision; the only such value in a manifest is the "sparse hole"
// extent start (2^64 - 1), which is refused anyway.
function* fields(b) {
  let i = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= b.length) throw new PayloadError("The payload manifest is damaged (truncated).");
      const c = b[i++];
      v += (c & 0x7f) * mul;
      if (!(c & 0x80)) return v;
      mul *= 128;
    }
    throw new PayloadError("The payload manifest is damaged (bad integer).");
  };
  const take = (n) => {
    if (i + n > b.length) throw new PayloadError("The payload manifest is damaged (truncated).");
    const v = b.subarray(i, i + n);
    i += n;
    return v;
  };
  while (i < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) yield [field, varint()];
    else if (wire === 2) yield [field, take(varint())];
    else if (wire === 1) yield [field, take(8)];
    else if (wire === 5) yield [field, take(4)];
    else throw new PayloadError(`The payload manifest uses protobuf wire type ${wire}, which is not supported.`);
  }
}

const utf8 = new TextDecoder();

function parseExtent(b) {
  const e = { start: 0, num: 0 };
  for (const [f, v] of fields(b)) {
    if (f === 1) e.start = v;
    else if (f === 2) e.num = v;
  }
  return e;
}

function parseOp(b) {
  const op = { type: 0, dataOffset: 0, dataLength: 0, dst: [], srcExtents: 0, dataSha256: null, blocks: 0 };
  for (const [f, v] of fields(b)) {
    if (f === 1) op.type = v;
    else if (f === 2) op.dataOffset = v;
    else if (f === 3) op.dataLength = v;
    else if (f === 4) op.srcExtents++;
    else if (f === 6) op.dst.push(parseExtent(v));
    else if (f === 8) op.dataSha256 = toHex(v);
  }
  for (const e of op.dst) op.blocks += e.num;
  return op;
}

function parsePartition(b) {
  const p = { name: "", size: 0, sha256: null, ops: [], hasOldInfo: false };
  for (const [f, v] of fields(b)) {
    if (f === 1) p.name = utf8.decode(v);
    else if (f === 6) p.hasOldInfo = true;
    else if (f === 7) {
      for (const [g, x] of fields(v)) {
        if (g === 1) p.size = x;
        else if (g === 2) p.sha256 = toHex(x);
      }
    } else if (f === 8) p.ops.push(parseOp(v));
  }
  return p;
}

function parseDynamic(b) {
  const d = { groups: [], snapshotEnabled: false, vabcEnabled: false };
  for (const [f, v] of fields(b)) {
    if (f === 1) {
      const g = { name: "", size: 0, partitions: [] };
      for (const [h, x] of fields(v)) {
        if (h === 1) g.name = utf8.decode(x);
        else if (h === 2) g.size = x;
        else if (h === 3) g.partitions.push(utf8.decode(x));
      }
      d.groups.push(g);
    } else if (f === 2) d.snapshotEnabled = !!v;
    else if (f === 3) d.vabcEnabled = !!v;
  }
  return d;
}

export function parseManifest(b) {
  const m = {
    blockSize: 4096,
    minorVersion: 0,
    partitions: [],
    dynamic: null,
    partialUpdate: false,
    securityPatchLevel: "",
    maxTimestamp: 0,
  };
  for (const [f, v] of fields(b)) {
    if (f === 1 || f === 2) throw new PayloadError("This payload has the old major version 1, which is not supported.");
    if (f === 3) m.blockSize = v;
    else if (f === 12) m.minorVersion = v;
    else if (f === 13) m.partitions.push(parsePartition(v));
    else if (f === 14) m.maxTimestamp = v;
    else if (f === 15) m.dynamic = parseDynamic(v);
    else if (f === 16) m.partialUpdate = !!v;
    else if (f === 18) m.securityPatchLevel = utf8.decode(v);
  }
  return m;
}

// ---------------------------------------------------------------- reading the data blobs

// Operations come in the order of their data, so reads go through windows of 16 MiB. While
// one is used, the next is fetched; consecutive windows overlap by more than an operation's
// data, so that an operation never needs two of them.
const WINDOW = 16 << 20;
const OVERLAP = 3 << 20;

class BlobReader {
  constructor(file, start, end) {
    this.file = file;
    this.start = start;
    this.size = end - start;
    this.win = null; // { off, len, bytes }
    this.ahead = null; // { off, len, promise }
  }

  window(off) {
    const len = Math.min(WINDOW, this.size - off);
    const promise = this.file
      .slice(this.start + off, this.start + off + len)
      .arrayBuffer()
      .then((b) => new Uint8Array(b));
    return { off, len, promise };
  }

  async read(off, len) {
    if (off + len > this.size) throw new PayloadError("payload.bin is shorter than its manifest says.");
    const inside = (w) => w && off >= w.off && off + len <= w.off + w.len;
    if (len > OVERLAP) {
      return new Uint8Array(await this.file.slice(this.start + off, this.start + off + len).arrayBuffer());
    }
    if (!inside(this.win)) {
      const w = inside(this.ahead) ? this.ahead : this.window(off);
      this.win = { off: w.off, len: w.len, bytes: await w.promise };
      const next = w.off + w.len - OVERLAP;
      this.ahead = w.off + w.len < this.size ? this.window(next) : null;
      this.ahead?.promise.catch(() => {});
    }
    const w = this.win;
    return w.bytes.subarray(off - w.off, off - w.off + len);
  }
}

// ---------------------------------------------------------------- the package

export class OtaPackage {
  static async open(file) {
    const zip = await ZipFile.open(file);
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    const entry = byName.get("payload.bin");
    if (!entry) throw new PayloadError("This zip has no payload.bin: it is not an A/B OTA package.");
    if (entry.method !== 0) throw new PayloadError("payload.bin is compressed inside the zip; OTA packages store it as it is.");
    const start = await zip.dataStart(entry);
    const head = new Uint8Array(await file.slice(start, start + 24).arrayBuffer());
    const hv = new DataView(head.buffer);
    if (head.length < 24 || utf8.decode(head.subarray(0, 4)) !== "CrAU") throw new PayloadError("payload.bin is not an update payload.");
    const version = Number(hv.getBigUint64(4));
    if (version !== 2) throw new PayloadError(`payload.bin has format version ${version}; this page reads version 2.`);
    const manifestSize = Number(hv.getBigUint64(12));
    const signatureSize = hv.getUint32(20);
    if (24 + manifestSize + signatureSize > entry.size) throw new PayloadError("payload.bin is damaged (manifest size).");
    const manifestBytes = new Uint8Array(await file.slice(start + 24, start + 24 + manifestSize).arrayBuffer());

    const props = await keyValues(zip, byName.get("payload_properties.txt"));
    if (props.METADATA_HASH) {
      const sha = new Sha256().update(head).update(manifestBytes).digest();
      if (b64(sha) !== props.METADATA_HASH || Number(props.METADATA_SIZE) !== 24 + manifestSize) {
        throw new PayloadError("The payload manifest does not match the checksum in payload_properties.txt.");
      }
    }
    if (props.FILE_SIZE && Number(props.FILE_SIZE) !== entry.size) {
      throw new PayloadError("payload.bin does not have the size payload_properties.txt gives.");
    }
    const metadata = await keyValues(zip, byName.get("META-INF/com/android/metadata"));
    const manifest = parseManifest(manifestBytes);
    const pkg = new OtaPackage(file, manifest, props, metadata, start + 24 + manifestSize + signatureSize, start + entry.size);
    pkg.validate();
    return pkg;
  }

  constructor(file, manifest, props, metadata, dataStart, payloadEnd) {
    this.file = file;
    this.manifest = manifest;
    this.properties = props;
    this.metadata = metadata;
    this.dataStart = dataStart;
    this.payloadEnd = payloadEnd;
    this.partitions = new Map(manifest.partitions.map((p) => [p.name, new PayloadPartition(this, p)]));
  }

  // Everything this page relies on, before any data is read.
  validate() {
    const m = this.manifest;
    if (m.minorVersion !== 0) {
      throw new PayloadError("This is an incremental OTA package (an update from one build to the next); a full one is needed.");
    }
    if (m.blockSize !== 4096) throw new PayloadError(`The payload uses ${m.blockSize}-byte blocks; 4096 are expected.`);
    const dataSize = this.payloadEnd - this.dataStart;
    for (const p of m.partitions) {
      const bad = (what) => new PayloadError(`The payload's ${p.name} partition ${what}.`);
      if (!p.name || !/^[a-z0-9_]+$/.test(p.name)) throw new PayloadError("The payload names a partition oddly.");
      if (!p.sha256) throw bad("has no checksum");
      if (p.size % m.blockSize !== 0) throw bad("is not a whole number of blocks");
      const total = p.size / m.blockSize;
      let next = 0;
      for (const op of p.ops) {
        if (!SUPPORTED.has(op.type)) throw bad(`uses the ${OP_NAMES[op.type] || op.type} operation, which needs the previous build`);
        if (op.srcExtents) throw bad("reads from the previous build");
        if (!op.dst.length) throw bad("has an operation without a destination");
        for (const e of op.dst) {
          if (e.start > Number.MAX_SAFE_INTEGER || e.num === 0) throw bad("has an unsupported extent");
          if (e.start < next) throw bad("has operations out of order");
          next = e.start + e.num;
        }
        if (next > total) throw bad("writes beyond its size");
        if (hasData(op)) {
          if (op.dataOffset + op.dataLength > dataSize) throw bad("points beyond the payload data");
          if (!op.dataSha256) throw bad("has an operation without a checksum");
          if (op.type === OP_REPLACE && op.dataLength > op.blocks * m.blockSize) throw bad("has an oversized operation");
        }
      }
    }
  }

  get reader() {
    if (!this.blobs) this.blobs = new BlobReader(this.file, this.dataStart, this.payloadEnd);
    return this.blobs;
  }

  partition(name) {
    return this.partitions.get(name) || null;
  }
}

async function keyValues(zip, entry) {
  const out = {};
  if (!entry) return out;
  for (const line of (await zip.text(entry)).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// ---------------------------------------------------------------- one partition

const ZEROS = new Uint8Array(2 << 20);
const FILL_ZERO = new Uint8Array(4);

export class PayloadPartition {
  constructor(pkg, p) {
    this.pkg = pkg;
    this.name = p.name;
    this.size = p.size;
    this.sha256 = p.sha256;
    this.ops = p.ops;
    this.blockSize = pkg.manifest.blockSize;
    this.totalBlocks = p.size / this.blockSize;
  }

  // The data of one operation, unpacked and padded with zeros to its blocks.
  async decode(op, { checkData = false } = {}) {
    await yieldNow();
    const need = op.blocks * this.blockSize;
    const raw = await this.pkg.reader.read(op.dataOffset, op.dataLength);
    if (checkData && new Sha256().update(raw).hex() !== op.dataSha256) {
      throw new PayloadError(`The payload's ${this.name} data is damaged (an operation's checksum does not match).`);
    }
    let data;
    if (op.type === OP_REPLACE_XZ) data = xzDecompress(raw, need);
    else if (op.type === OP_REPLACE_BZ) data = bzip2Decompress(raw, need);
    else data = raw;
    if (data.length > need) throw new PayloadError(`The payload's ${this.name} data unpacks to too much.`);
    if (data.length < need || data.byteOffset % 4 || data === raw) {
      // a private, aligned copy: `raw` is a view into the read window
      const padded = new Uint8Array(need);
      padded.set(data);
      data = padded;
    }
    return data;
  }

  // The partition's bytes in order, as Uint8Array pieces.
  async *pieces({ checkData = false } = {}) {
    const bs = this.blockSize;
    let next = 0;
    const zeros = function* (blocks) {
      let left = blocks * bs;
      while (left > 0) {
        const n = Math.min(left, ZEROS.length);
        yield ZEROS.subarray(0, n);
        left -= n;
      }
    };
    for (const op of this.ops) {
      const data = hasData(op) ? await this.decode(op, { checkData }) : null;
      let off = 0;
      for (const e of op.dst) {
        await yieldNow();
        if (e.start > next) yield* zeros(e.start - next);
        if (data) yield data.subarray(off, off + e.num * bs);
        else yield* zeros(e.num);
        off += e.num * bs;
        next = e.start + e.num;
      }
    }
    if (next < this.totalBlocks) yield* zeros(this.totalBlocks - next);
  }

  // The chunks of a sparse image of the whole partition, in ascending block order. RAW
  // chunks carry their data; ZERO operations, gaps and blocks that repeat one 4-byte value
  // are FILL chunks.
  async *chunks() {
    const bs = this.blockSize;
    let next = 0;
    for (const op of this.ops) {
      const data = hasData(op) ? await this.decode(op) : null;
      let off = 0;
      for (const e of op.dst) {
        if (e.start > next) yield { type: CHUNK_FILL, start: next, blocks: e.start - next, value: FILL_ZERO };
        if (data) yield* fillsAndData(data.subarray(off, off + e.num * bs), e.start, bs);
        else yield { type: CHUNK_FILL, start: e.start, blocks: e.num, value: FILL_ZERO };
        off += e.num * bs;
        next = e.start + e.num;
      }
    }
    if (next < this.totalBlocks) yield { type: CHUNK_FILL, start: next, blocks: this.totalBlocks - next, value: FILL_ZERO };
  }

  // The partition as one stream (for images small enough to be sent unchanged).
  stream() {
    const it = this.pieces();
    return new ReadableStream({
      async pull(controller) {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await it.return();
      },
    });
  }

  // Unpacks everything once and checks the SHA-256 of every operation's data and of the
  // whole partition. onBytes(n) reports progress in partition bytes.
  async verify(onBytes = () => {}) {
    const sha = new Sha256();
    for await (const piece of this.pieces({ checkData: true })) {
      sha.update(piece);
      onBytes(piece.length);
    }
    if (sha.hex() !== this.sha256) {
      throw new PayloadError(`The unpacked ${this.name} partition does not match its checksum in the payload.`);
    }
  }

  // The first n bytes (n up to one operation).
  async head(n) {
    const it = this.pieces();
    try {
      const { value } = await it.next();
      return value ? value.slice(0, n) : new Uint8Array(0);
    } finally {
      await it.return();
    }
  }

  // An image for Installer.flash(): sent unchanged when it fits into one download, otherwise
  // as sparse pieces built from chunks().
  image(label) {
    return {
      name: label || this.name,
      size: this.size,
      crc32: null,
      blockSize: this.blockSize,
      totalBlocks: this.totalBlocks,
      open: async () => this.stream(),
      chunks: () => this.chunks(),
    };
  }
}

// Splits a run of whole blocks into RAW chunks and FILL chunks for blocks that repeat one
// 4-byte value (as img2simg does). Adjacent blocks of the same kind share a chunk.
function* fillsAndData(data, start, bs) {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length >>> 2);
  const wpb = bs >>> 2;
  const n = data.length / bs;
  let runStart = 0;
  let runFill = false;
  let runWord = 0;
  const emit = (end) =>
    runFill
      ? { type: CHUNK_FILL, start: start + runStart, blocks: end - runStart, value: data.slice(runStart * bs, runStart * bs + 4) }
      : { type: CHUNK_RAW, start: start + runStart, blocks: end - runStart, data: data.subarray(runStart * bs, end * bs) };
  for (let b = 0; b < n; b++) {
    const base = b * wpb;
    const w0 = words[base];
    let fill = true;
    for (let k = 1; k < wpb; k++) {
      if (words[base + k] !== w0) {
        fill = false;
        break;
      }
    }
    if (b > 0 && (fill !== runFill || (fill && w0 !== runWord))) {
      yield emit(b);
      runStart = b;
    }
    runFill = fill;
    runWord = w0;
  }
  if (n > 0) yield emit(n);
}
