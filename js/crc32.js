// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// CRC-32 (IEEE 802.3, the checksum zip stores for every entry), slicing-by-4.

const TABLE = (() => {
  const t = new Uint32Array(4 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 4; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c >>> 0;
    }
  }
  return t;
})();

export class Crc32 {
  constructor() {
    this.crc = -1;
  }

  update(buf) {
    const t = TABLE;
    let c = this.crc;
    let i = 0;
    const n = buf.length;
    const n4 = n - (n & 3);
    for (; i < n4; i += 4) {
      c ^= buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
      c = t[768 + (c & 0xff)] ^ t[512 + ((c >>> 8) & 0xff)] ^ t[256 + ((c >>> 16) & 0xff)] ^ t[c >>> 24];
    }
    for (; i < n; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    this.crc = c;
    return this;
  }

  digest() {
    return (this.crc ^ -1) >>> 0;
  }
}
