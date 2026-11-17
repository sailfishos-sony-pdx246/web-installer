// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Simulation only: a File-like object for a file on the test server, read with HTTP range
// requests (tools/dev_server.py), so that large test images are never held in memory.

export class RangeFile {
  constructor(url, size, name, start = 0, end = size) {
    this.url = url;
    this.fileSize = size;
    this.name = name;
    this.start = start;
    this.end = end;
  }

  static async open(url) {
    if (/^[a-z]+:|^\/\//i.test(url)) throw new Error("only same-site test files");
    const r = await fetch(url, { method: "HEAD" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const size = Number(r.headers.get("Content-Length"));
    return new RangeFile(url, size, url.split("/").pop());
  }

  get size() {
    return this.end - this.start;
  }

  slice(start = 0, end = this.size) {
    const s = Math.min(Math.max(start, 0), this.size);
    const e = Math.min(Math.max(end, s), this.size);
    return new RangeFile(this.url, this.fileSize, this.name, this.start + s, this.start + e);
  }

  async response() {
    if (this.size === 0) return new Response(new Uint8Array(0));
    const r = await fetch(this.url, { headers: { Range: `bytes=${this.start}-${this.end - 1}` } });
    if (r.status !== 206 && !(r.status === 200 && this.start === 0 && this.end === this.fileSize)) {
      throw new Error(`${this.url}: HTTP ${r.status}`);
    }
    return r;
  }

  async arrayBuffer() {
    return (await this.response()).arrayBuffer();
  }

  stream() {
    const self = this;
    let reader = null;
    return new ReadableStream({
      async pull(controller) {
        if (!reader) reader = (await self.response()).body.getReader();
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader && reader.cancel(reason);
      },
    });
  }
}
