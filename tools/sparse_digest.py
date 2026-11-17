#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""Reference digests of what images write, for checking the page's results.

For an Android sparse image: SHA-256 over (block number as 8 bytes little-endian, block
data) for every block it writes, in ascending order; DONT_CARE blocks are left out. This
does not depend on how the image is chunked or split, so it equals the digest the
simulated phone (js/mock-usb.js, BlockDigest in js/sparse.js) computes from the pieces the
page sends. For any other image: the plain SHA-256 of the file.

Usage: sparse_digest.py IMAGE_OR_ZIP [NAME ...]
  A zip is read in place (entries in its single top-level folder); NAMEs select entries.
  --blocks: give the block digest also for non-sparse images (all blocks written).
Prints JSON: {name: {"kind": "sparse"|"raw", "digest"|"sha256": ..., ...}}.
"""
import hashlib
import json
import struct
import sys
import zipfile

SPARSE_MAGIC = 0xED26FF3A


def read_exact(f, n):
    b = f.read(n)
    if len(b) != n:
        raise ValueError("truncated image")
    return b


def sparse_digest(f, head):
    magic, major, minor, fhs, chs, bs, total_blocks, total_chunks, _ = struct.unpack("<IHHHHIIII", head)
    assert magic == SPARSE_MAGIC and major == 1
    read_exact(f, fhs - 28)
    h = hashlib.sha256()
    pos = 0
    written = 0
    for _ in range(total_chunks):
        hdr = read_exact(f, chs)
        ctype, _, blocks, total = struct.unpack("<HHII", hdr[:12])
        if ctype == 0xCAC1:  # RAW
            assert total - chs == blocks * bs
            for b in range(blocks):
                h.update(struct.pack("<Q", pos + b))
                h.update(read_exact(f, bs))
            written += blocks
        elif ctype == 0xCAC2:  # FILL
            assert total - chs == 4
            block = read_exact(f, 4) * (bs // 4)
            for b in range(blocks):
                h.update(struct.pack("<Q", pos + b))
                h.update(block)
            written += blocks
        elif ctype == 0xCAC3:  # DONT_CARE
            assert total == chs
        elif ctype == 0xCAC4:  # CRC32
            read_exact(f, 4)
            blocks = 0
        else:
            raise ValueError(f"unknown chunk type {ctype:#x}")
        pos += blocks
    assert pos == total_blocks, (pos, total_blocks)
    return {"kind": "sparse", "digest": h.hexdigest(), "blocks": written, "total_blocks": total_blocks, "block_size": bs}


def raw_block_digest(f, size, bs=4096):
    h = hashlib.sha256()
    assert size % bs == 0
    for b in range(size // bs):
        h.update(struct.pack("<Q", b))
        h.update(read_exact(f, bs))
    return {"kind": "sparse", "digest": h.hexdigest(), "blocks": size // bs}


def digest(open_fn, size, blocks_for_raw=False):
    with open_fn() as f:
        head = f.read(28)
        if len(head) == 28 and struct.unpack("<I", head[:4])[0] == SPARSE_MAGIC:
            return sparse_digest(f, head)
    if blocks_for_raw:
        with open_fn() as f:
            return raw_block_digest(f, size)
    h = hashlib.sha256()
    with open_fn() as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return {"kind": "raw", "sha256": h.hexdigest(), "size": size}


def main(argv):
    blocks_for_raw = "--blocks" in argv
    args = [a for a in argv if a != "--blocks"]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    path, names = args[0], args[1:]
    out = {}
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                base = info.filename.rsplit("/", 1)[-1]
                if names and base not in names:
                    continue
                out[base] = digest(lambda: z.open(info), info.file_size, blocks_for_raw)
    else:
        import os
        size = os.path.getsize(path)
        out[os.path.basename(path)] = digest(lambda: open(path, "rb"), size, blocks_for_raw)
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
