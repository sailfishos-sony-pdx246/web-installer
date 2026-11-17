#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""Local test server: serves the page from this repository on 127.0.0.1 without caching,
and accepts PUT /upload/NAME into --upload-dir, so test/index.html can hand the sparse
pieces it produces to AOSP's simg2img and tools/check_pieces.py.

Usage: dev_server.py [--port 8765] [--upload-dir DIR]
"""
import argparse
import http.server
import os
import re

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


class Handler(http.server.SimpleHTTPRequestHandler):
    upload_dir = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # Single byte ranges, so that the test page can read large files in slices
    # (js/mock-files.js) instead of loading them whole.
    def send_head(self):
        self.range_remaining = None
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or os.path.isdir(path):
            return super().send_head()
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", rng.strip())
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404)
            return None
        size = os.fstat(f.fileno()).st_size
        start = int(m.group(1)) if m else size
        end = min(int(m.group(2)), size - 1) if m and m.group(2) else size - 1
        if start >= size or end < start:
            f.close()
            self.send_error(416)
            return None
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        f.seek(start)
        self.range_remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            buf = source.read(min(1 << 20, remaining))
            if not buf:
                break
            outputfile.write(buf)
            remaining -= len(buf)

    def do_PUT(self):
        m = re.fullmatch(r"/upload/([A-Za-z0-9._-]+)", self.path)
        if not m or not self.upload_dir:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 64 << 20:
            self.send_error(413)
            return
        data = self.rfile.read(length)
        with open(os.path.join(self.upload_dir, m.group(1)), "wb") as f:
            f.write(data)
        self.send_response(204)
        self.end_headers()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--upload-dir")
    a = p.parse_args()
    if a.upload_dir:
        os.makedirs(a.upload_dir, exist_ok=True)
        Handler.upload_dir = a.upload_dir
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"serving {ROOT} on http://127.0.0.1:{a.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
