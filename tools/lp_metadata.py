#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""The super partition's table ("LP metadata", AOSP system/core/fs_mgr/liblp) in Python.

A second implementation next to js/lp-metadata.js, for the tests:
- build_super_empty(): the empty table lpmake writes for a layout (super_empty.img);
- read(): parse a table image or the start of a super image (raw or sparse), with liblp's
  checks;
- emptied(): the same table without extents, as super_empty.img of that build would be.

Usage: lp_metadata.py FILE    prints the table of a super_empty.img or a (sparse) super.img
"""
import hashlib
import json
import struct
import sys

SECTOR = 512
GEOMETRY_SIZE = 4096
RESERVED = 4096
GEOMETRY_MAGIC = 0x616C4467
HEADER_MAGIC = 0x414C5030
VIRTUAL_AB = 1


def total_metadata_size(max_size, slots):
    return RESERVED + (GEOMETRY_SIZE + max_size * slots) * 2


def align_up(v, a):
    return (v + a - 1) // a * a


def name36(s):
    b = s.encode("ascii")
    assert 0 < len(b) <= 36, s
    return b + bytes(36 - len(b))


def geometry_block(max_size, slots, block_size):
    g = struct.pack("<II32sIII", GEOMETRY_MAGIC, 52, bytes(32), max_size, slots, block_size)
    g = g[:8] + hashlib.sha256(g).digest() + g[40:]
    return g + bytes(GEOMETRY_SIZE - len(g))


def serialize(geometry, header_size, minor, flags, partitions, extents, groups, devices):
    """geometry: (max_size, slots, block_size); partitions: (name, attrs, first, num, group_index);
    extents: (sectors, type, data, source); groups: (name, flags, max); devices: (first, align, offset, size, name, flags)."""
    pt = b"".join(name36(n) + struct.pack("<IIII", a, f, k, g) for n, a, f, k, g in partitions)
    et = b"".join(struct.pack("<QIQI", *e) for e in extents)
    gt = b"".join(name36(n) + struct.pack("<IQ", fl, mx) for n, fl, mx in groups)
    bt = b"".join(struct.pack("<QIIQ", f, al, off, sz) + name36(n) + struct.pack("<I", fl) for f, al, off, sz, n, fl in devices)
    tables = pt + et + gt + bt
    desc = struct.pack(
        "<IIIIIIIIIIII",
        0, len(partitions), 52,
        len(pt), len(extents), 24,
        len(pt) + len(et), len(groups), 48,
        len(pt) + len(et) + len(gt), len(devices), 64,
    )
    header = struct.pack("<IHHI32sI32s", HEADER_MAGIC, 10, minor, header_size, bytes(32), len(tables), hashlib.sha256(tables).digest()) + desc
    if header_size == 256:
        header += struct.pack("<I", flags) + bytes(124)
    assert len(header) == header_size
    header = header[:12] + hashlib.sha256(header).digest() + header[44:]
    return geometry_block(*geometry) + header + tables


def build_super_empty(device_size, groups, partitions, metadata_max_size=65536, slots=3, block_size=4096,
                      alignment=1 << 20, alignment_offset=0, virtual_ab=False, super_name="super"):
    """groups: [(name, max_size)]; partitions: [(name, group, attributes)] in table order."""
    max_size = align_up(metadata_max_size, SECTOR)
    first = align_up(total_metadata_size(max_size, slots), alignment or block_size) // SECTOR
    assert device_size >= first * SECTOR + block_size
    all_groups = [("default", 0)] + list(groups)
    index = {g: i for i, (g, _) in enumerate(all_groups)}
    minor = 1 if any(a & 0xC for _, _, a in partitions) else 0
    header_size = 128
    flags = 0
    if virtual_ab:
        minor, header_size, flags = 2, 256, VIRTUAL_AB
    return serialize(
        (max_size, slots, block_size), header_size, minor, flags,
        [(n, a, 0, 0, index[g]) for n, g, a in partitions], [],
        [(n, 0, m) for n, m in all_groups],
        [(first, alignment, alignment_offset, device_size, super_name, 0)],
    )


def read(data):
    """Parses geometry + metadata (a table image), with liblp's checks. Returns a dict."""
    magic, struct_size = struct.unpack_from("<II", data, 0)
    assert magic == GEOMETRY_MAGIC, "geometry magic"
    g = bytearray(data[:struct_size])
    stored = bytes(g[8:40])
    g[8:40] = bytes(32)
    assert hashlib.sha256(g).digest() == stored, "geometry checksum"
    assert struct_size == 52, "geometry size"
    max_size, slots, block_size = struct.unpack_from("<III", data, 40)
    assert slots and max_size % SECTOR == 0
    m = data[GEOMETRY_SIZE:]
    magic, major, minor, header_size = struct.unpack_from("<IHHI", m, 0)
    assert magic == HEADER_MAGIC and major == 10 and minor <= 2, "header version"
    assert header_size == (128 if minor < 2 else 256), "header size"
    h = bytearray(m[:header_size])
    stored = bytes(h[12:44])
    h[12:44] = bytes(32)
    assert hashlib.sha256(h).digest() == stored, "header checksum"
    tables_size = struct.unpack_from("<I", m, 44)[0]
    desc = [struct.unpack_from("<III", m, 80 + 12 * i) for i in range(4)]
    for off, num, size in desc:
        assert off <= tables_size and tables_size - off >= num * size, "table bounds"
    assert [d[2] for d in desc[:3]] == [52, 24, 48], "entry sizes"
    flags = struct.unpack_from("<I", m, 128)[0] if header_size >= 132 else 0
    t = m[header_size:header_size + tables_size]
    assert hashlib.sha256(t).digest() == m[48:80], "tables checksum"

    def entries(i):
        off, num, size = desc[i]
        return [t[off + k * size: off + (k + 1) * size] for k in range(num)]

    cstr = lambda b: b.split(b"\0", 1)[0].decode()  # noqa: E731
    partitions = [(cstr(e[:36]),) + struct.unpack_from("<IIII", e, 36) for e in entries(0)]
    extents = [struct.unpack_from("<QIQI", e) for e in entries(1)]
    groups = [(cstr(e[:36]),) + struct.unpack_from("<IQ", e, 36) for e in entries(2)]
    devices = [struct.unpack_from("<QIIQ", e) + (cstr(e[24:60]),) + struct.unpack_from("<I", e, 60) for e in entries(3)]
    valid = 0x3 | (0xC if minor >= 1 else 0)
    for name, attrs, first, num, gi in partitions:
        assert not attrs & ~valid and first + num <= len(extents) and gi < len(groups), name
    assert devices and total_metadata_size(max_size, slots) <= devices[0][0] * SECTOR, "metadata overlap"
    return {
        "geometry": (max_size, slots, block_size), "version": (major, minor), "header_size": header_size, "flags": flags,
        "partitions": partitions, "extents": extents, "groups": groups, "devices": devices,
    }


def emptied(table):
    """The table with every extent removed: super_empty.img of the build that wrote it."""
    t = table
    return serialize(
        t["geometry"], t["header_size"], t["version"][1], t["flags"],
        [(n, a, 0, 0, g) for n, a, _, _, g in t["partitions"]], [], t["groups"], t["devices"],
    )


def table_from_super(path):
    """Geometry + slot-0 metadata from the start of a super image (raw or sparse)."""
    with open(path, "rb") as f:
        head = f.read(28)
        f.seek(0)
        if struct.unpack_from("<I", head)[0] != 0xED26FF3A:
            data = f.read(1 << 20)
        else:
            data = unsparse_head(f, 1 << 20)
    max_size = struct.unpack_from("<I", data, RESERVED + 40)[0]
    start = RESERVED + 2 * GEOMETRY_SIZE
    return data[RESERVED:RESERVED + GEOMETRY_SIZE] + data[start:start + max_size]


def unsparse_head(f, nbytes):
    magic, major, _, fhs, chs, bs, _, chunks, _ = struct.unpack("<IHHHHIIII", f.read(28))
    f.read(fhs - 28)
    out = bytearray()
    for _ in range(chunks):
        ctype, _, blocks, total = struct.unpack("<HHII", f.read(12))
        f.read(chs - 12)
        if ctype == 0xCAC1:
            out += f.read(blocks * bs)
        elif ctype == 0xCAC2:
            out += f.read(4) * (blocks * bs // 4)
        elif ctype == 0xCAC3:
            out += bytes(blocks * bs)
        elif ctype == 0xCAC4:
            f.read(4)
        if len(out) >= nbytes:
            break
    return bytes(out[:nbytes])


if __name__ == "__main__":
    with open(sys.argv[1], "rb") as f:
        head = f.read(GEOMETRY_SIZE + 4)
    if struct.unpack_from("<I", head)[0] == GEOMETRY_MAGIC:
        with open(sys.argv[1], "rb") as f:
            table = read(f.read())
    else:
        table = read(table_from_super(sys.argv[1]))
    print(json.dumps(table, indent=1))
