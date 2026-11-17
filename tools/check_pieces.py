#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""Checks sparse pieces uploaded by test/index.html, independently of the page's code:
every piece must be a valid sparse image of the full size and at most the split size;
together, applied in order, they must write exactly what the original image writes
(the block digest of tools/sparse_digest.py), each block once and in ascending order.

Usage: check_pieces.py UPLOAD_DIR FIXTURES_DIR
Pieces are named ORIGINAL-MAXSIZE-INDEX.simg, e.g. sparse-1.img-9000-0.simg.
"""
import collections
import hashlib
import json
import os
import re
import struct
import sys


def pieces_digest(paths):
    h = hashlib.sha256()
    nxt = 0
    written = 0
    total = None
    for path in paths:
        with open(path, "rb") as f:
            data = f.read()
        magic, major, minor, fhs, chs, bs, tb, tc, _ = struct.unpack("<IHHHHIIII", data[:28])
        assert magic == 0xED26FF3A and major == 1 and fhs == 28 and chs == 12, path
        total = tb if total is None else total
        assert tb == total, f"{path}: total blocks {tb} != {total}"
        off, pos = fhs, 0
        for _ in range(tc):
            ctype, _, blocks, tsz = struct.unpack("<HHII", data[off:off + 12])
            body = off + 12
            if ctype == 0xCAC1:
                assert tsz == 12 + blocks * bs
                for b in range(blocks):
                    assert pos + b >= nxt, f"{path}: block {pos + b} out of order"
                    h.update(struct.pack("<Q", pos + b))
                    h.update(data[body + b * bs: body + (b + 1) * bs])
                    nxt = pos + b + 1
                written += blocks
            elif ctype == 0xCAC2:
                assert tsz == 16
                block = data[body:body + 4] * (bs // 4)
                for b in range(blocks):
                    assert pos + b >= nxt, f"{path}: block {pos + b} out of order"
                    h.update(struct.pack("<Q", pos + b))
                    h.update(block)
                    nxt = pos + b + 1
                written += blocks
            elif ctype == 0xCAC3:
                assert tsz == 12
            else:
                raise AssertionError(f"{path}: unexpected chunk type {ctype:#x}")
            pos += blocks
            off += tsz
        assert pos == tb, f"{path}: covers {pos} of {tb} blocks"
        assert off == len(data), f"{path}: {len(data) - off} bytes after the last chunk"
    return h.hexdigest(), written


def main(upload_dir, fixtures):
    expected = json.load(open(os.path.join(fixtures, "expected.json")))["sparse"]
    groups = collections.defaultdict(list)
    for name in os.listdir(upload_dir):
        m = re.fullmatch(r"(.+)-(\d+)-(\d+)\.simg", name)
        if m:
            groups[(m.group(1), int(m.group(2)))].append((int(m.group(3)), os.path.join(upload_dir, name)))
    failures = 0
    for (orig, maxsize), items in sorted(groups.items()):
        items.sort()
        paths = [p for _, p in items]
        too_big = [p for p in paths if os.path.getsize(p) > maxsize]
        digest, written = pieces_digest(paths)
        ok = not too_big and digest == expected[orig]["digest"] and written == expected[orig]["blocks"]
        failures += not ok
        print(f"{'OK  ' if ok else 'FAIL'} {orig} split at {maxsize}: {len(paths)} pieces, {written} blocks"
              + (f", too big: {too_big}" if too_big else "")
              + ("" if digest == expected[orig]["digest"] else ", digest differs"))
    return 1 if failures or not groups else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
