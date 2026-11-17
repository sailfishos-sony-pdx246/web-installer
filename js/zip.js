// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Minimal zip reader for the image zip: reads the central directory (with ZIP64)
// and streams single entries, inflating them with the browser's DecompressionStream.
// The zip is read in place from the File, so a 2 GB image never sits in memory.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function viewOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

export class ZipFile {
  constructor(blob, entries) {
    this.blob = blob;
    this.entries = entries;
  }

  static async open(blob) {
    const size = blob.size;
    if (size < 22) throw new Error("This is not a zip file.");
    const tailLen = Math.min(size, 22 + 0xffff + 20);
    const tail = await readRange(blob, size - tailLen, size);
    const tv = viewOf(tail);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("This is not a zip file, or it is incomplete.");

    let count = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOffset = tv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tv.getUint32(loc, true) !== SIG_EOCD64_LOCATOR) {
        throw new Error("The zip file is damaged (ZIP64 locator missing).");
      }
      const recOffset = Number(tv.getBigUint64(loc + 8, true));
      const rec = await readRange(blob, recOffset, recOffset + 56);
      const rv = viewOf(rec);
      if (rec.length < 56 || rv.getUint32(0, true) !== SIG_EOCD64) {
        throw new Error("The zip file is damaged (ZIP64 end record missing).");
      }
      count = Number(rv.getBigUint64(32, true));
      cdSize = Number(rv.getBigUint64(40, true));
      cdOffset = Number(rv.getBigUint64(48, true));
    }
    if (cdOffset + cdSize > size) throw new Error("The zip file is incomplete.");

    const cd = await readRange(blob, cdOffset, cdOffset + cdSize);
    const cv = viewOf(cd);
    const decoder = new TextDecoder();
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error("The zip file is damaged (central directory).");
      }
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      const crc32 = cv.getUint32(p + 16, true);
      let compressedSize = cv.getUint32(p + 20, true);
      let uncompressedSize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let localHeaderOffset = cv.getUint32(p + 42, true);
      const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));

      // The ZIP64 extra field holds, in this order, the values whose 32-bit fields are 0xffffffff.
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      while (q + 4 <= extraEnd) {
        const id = cv.getUint16(q, true);
        const len = cv.getUint16(q + 2, true);
        if (id === 0x0001) {
          let r = q + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(cv.getBigUint64(r, true));
            r += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(cv.getBigUint64(r, true));
            r += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(cv.getBigUint64(r, true));
          }
        }
        q += 4 + len;
      }

      entries.push({
        name,
        flags,
        method,
        crc32,
        compressedSize,
        size: uncompressedSize,
        localHeaderOffset,
        isDirectory: name.endsWith("/"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipFile(blob, entries);
  }

  // Files directly in the zip's root or in its single top-level folder, by base name.
  imageFiles() {
    const files = this.entries.filter((e) => !e.isDirectory);
    const tops = new Set(files.map((e) => (e.name.includes("/") ? e.name.split("/")[0] : "")));
    const map = new Map();
    if (tops.size !== 1) return map;
    for (const e of files) {
      const parts = e.name.split("/");
      if (parts.length <= 2) map.set(parts[parts.length - 1], e);
    }
    return map;
  }

  async dataStart(entry) {
    const hdr = await readRange(this.blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
    const hv = viewOf(hdr);
    if (hdr.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
      throw new Error(`The zip file is damaged (${entry.name}).`);
    }
    return entry.localHeaderOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  }

  async stream(entry) {
    if (entry.flags & 1) throw new Error(`${entry.name} is encrypted.`);
    const start = await this.dataStart(entry);
    const raw = this.blob.slice(start, start + entry.compressedSize).stream();
    if (entry.method === 0) return raw;
    if (entry.method === 8) return raw.pipeThrough(new DecompressionStream("deflate-raw"));
    throw new Error(`${entry.name} uses zip compression method ${entry.method}, which this page cannot read.`);
  }

  async bytes(entry) {
    const buf = await new Response(await this.stream(entry)).arrayBuffer();
    return new Uint8Array(buf);
  }

  async text(entry) {
    return new TextDecoder().decode(await this.bytes(entry));
  }
}
