#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""Unpacks the partitions of an A/B OTA zip's payload.bin with Python's lzma and bz2, as
a second implementation next to js/payload.js, and prints for each partition its size, its
SHA-256 (checked against the payload's) and the block digest of tools/sparse_digest.py with
every block written. That digest is what the simulated phone reports for a partition the
page sent in sparse pieces.

Usage: payload_digest.py OTA.zip [PARTITION ...]
"""
import bz2
import hashlib
import json
import lzma
import struct
import sys
import zipfile


def varint(b, i):
    v = s = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return v, i


def fields(b):
    i = 0
    while i < len(b):
        key, i = varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 2:
            n, i = varint(b, i)
            v = b[i:i + n]
            i += n
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError(f"wire type {wt}")
        yield f, v


def manifest_partitions(m):
    for f, v in fields(m):
        if f != 13:
            continue
        p = {"ops": []}
        for g, x in fields(v):
            if g == 1:
                p["name"] = x.decode()
            elif g == 7:
                for h, y in fields(x):
                    if h == 1:
                        p["size"] = y
                    elif h == 2:
                        p["sha256"] = y.hex()
            elif g == 8:
                op = {"type": 0, "offset": 0, "length": 0, "dst": []}
                for h, y in fields(x):
                    if h == 1:
                        op["type"] = y
                    elif h == 2:
                        op["offset"] = y
                    elif h == 3:
                        op["length"] = y
                    elif h == 6:
                        e = dict(fields(y))
                        op["dst"].append((e.get(1, 0), e.get(2, 0)))
                p["ops"].append(op)
        yield p


def main(path, names):
    z = zipfile.ZipFile(path)
    info = z.getinfo("payload.bin")
    with open(path, "rb") as f:
        f.seek(info.header_offset)
        local = f.read(30)
        start = info.header_offset + 30 + sum(struct.unpack("<HH", local[26:30]))
        f.seek(start)
        magic, version, msize, sigsize = struct.unpack(">4sQQI", f.read(24))
        assert magic == b"CrAU" and version == 2
        manifest = f.read(msize)
        data_start = start + 24 + msize + sigsize
        out = {}
        for p in manifest_partitions(manifest):
            if names and p["name"] not in names:
                continue
            bs = 4096
            sha = hashlib.sha256()
            blocks = hashlib.sha256()
            nxt = 0

            def put(block_index, data):
                for k in range(len(data) // bs):
                    blocks.update(struct.pack("<Q", block_index + k))
                    blocks.update(data[k * bs:(k + 1) * bs])
                sha.update(data)

            for op in p["ops"]:
                need = sum(n for _, n in op["dst"]) * bs
                if op["type"] in (0, 1, 8):
                    f.seek(data_start + op["offset"])
                    raw = f.read(op["length"])
                    data = raw if op["type"] == 0 else bz2.decompress(raw) if op["type"] == 1 else lzma.decompress(raw)
                    data = data + bytes(need - len(data))
                elif op["type"] in (6, 7):
                    data = bytes(need)
                else:
                    raise ValueError(f"{p['name']}: operation type {op['type']}")
                off = 0
                for s, n in op["dst"]:
                    if s > nxt:
                        put(nxt, bytes((s - nxt) * bs))
                    put(s, data[off:off + n * bs])
                    off += n * bs
                    nxt = s + n
            total = p["size"] // bs
            if nxt < total:
                put(nxt, bytes((total - nxt) * bs))
            digest = sha.hexdigest()
            assert digest == p["sha256"], f"{p['name']}: unpacked data does not match the payload's SHA-256"
            out[p["name"]] = {"size": p["size"], "sha256": digest, "block_digest": blocks.hexdigest()}
            print(f"{p['name']}: ok", file=sys.stderr)
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], set(sys.argv[2:]))
