#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""Writes the synthetic fixtures for test/index.html into test/fixtures/ (not committed).

- sparse-*.img: sparse images with RAW, FILL, DONT_CARE and CRC32 chunks, including RAW
  chunks far larger than the split sizes the tests use, and raw-1.img (not sparse);
- test.zip: stored, deflated and ZIP64 entries in one top-level folder, and a directory;
- expected.json: the reference digests (tools/sparse_digest.py) and entry checksums.
"""
import hashlib
import json
import os
import random
import struct
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sparse_digest  # noqa: E402

BS = 4096


def chunk(ctype, blocks, payload=b""):
    return struct.pack("<HHII", ctype, 0, blocks, 12 + len(payload)) + payload


def sparse(total_blocks, chunks):
    used = 0
    body = b""
    n = 0
    for c in chunks:
        body += c
        n += 1
        used += struct.unpack("<HHII", c[:12])[2] if struct.unpack("<H", c[:2])[0] != 0xCAC4 else 0
    assert used == total_blocks, (used, total_blocks)
    return struct.pack("<IHHHHIIII", 0xED26FF3A, 1, 0, 28, 12, BS, total_blocks, n, 0) + body


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "fixtures")
    os.makedirs(out, exist_ok=True)
    rnd = random.Random(246)
    data = lambda blocks: rnd.randbytes(blocks * BS)  # noqa: E731

    images = {
        # leading DONT_CARE, big RAW, FILL, CRC32, small RAWs, trailing DONT_CARE
        "sparse-1.img": sparse(
            400,
            [
                chunk(0xCAC3, 3),
                chunk(0xCAC1, 150, data(150)),
                chunk(0xCAC2, 40, b"\xaa\xbb\xcc\xdd"),
                chunk(0xCAC4, 0, b"\0\0\0\0"),
                chunk(0xCAC1, 1, data(1)),
                chunk(0xCAC3, 10),
                chunk(0xCAC1, 7, data(7)),
                chunk(0xCAC2, 100, b"\0\0\0\0"),
                chunk(0xCAC1, 20, data(20)),
                chunk(0xCAC3, 69),
            ],
        ),
        # many small chunks, starting at block 0, ending with data
        "sparse-2.img": sparse(
            3 * 64,
            [c for i in range(64) for c in (chunk(0xCAC1, 1, data(1)), chunk(0xCAC2, 1, struct.pack("<I", i)), chunk(0xCAC3, 1))],
        ),
        # only DONT_CARE
        "sparse-3.img": sparse(50, [chunk(0xCAC3, 50)]),
        # one huge RAW chunk
        "sparse-4.img": sparse(300, [chunk(0xCAC1, 300, data(300))]),
    }
    for name, img in images.items():
        with open(os.path.join(out, name), "wb") as f:
            f.write(img)
    with open(os.path.join(out, "raw-1.img"), "wb") as f:
        f.write(data(130))

    expected = {"sparse": {}, "zip": {}}
    for name in list(images) + ["raw-1.img"]:
        path = os.path.join(out, name)
        expected["sparse"][name] = sparse_digest.digest(
            lambda p=path: open(p, "rb"), os.path.getsize(path), blocks_for_raw=True
        )

    entries = {
        "img/readme.txt": (b"stored entry\n" * 10, zipfile.ZIP_STORED, False),
        "img/text.txt": (("deflated entry, line %d\n" * 1).encode() * 2000, zipfile.ZIP_DEFLATED, False),
        "img/random.bin": (rnd.randbytes(300000), zipfile.ZIP_DEFLATED, False),
        "img/zip64.bin": (rnd.randbytes(70000) + bytes(200000), zipfile.ZIP_DEFLATED, True),
        "img/empty.txt": (b"", zipfile.ZIP_STORED, False),
    }
    with zipfile.ZipFile(os.path.join(out, "test.zip"), "w") as z:
        z.writestr(zipfile.ZipInfo("img/"), b"")
        for name, (content, method, force64) in entries.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = method
            with z.open(info, "w", force_zip64=force64) as f:
                f.write(content)
            expected["zip"][name] = {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}

    # Python writes ZIP64 fields into the central directory only above 4 GiB; this one has
    # them for a small entry, plus a ZIP64 end record, to test that path of js/zip.js.
    content = b"zip64 central directory entry\n" * 5
    write_zip64(os.path.join(out, "zip64.zip"), "img/a.txt", content)
    with zipfile.ZipFile(os.path.join(out, "zip64.zip")) as z:
        assert z.read("img/a.txt") == content
    expected["zip64"] = {"img/a.txt": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}}

    with open(os.path.join(out, "expected.json"), "w") as f:
        json.dump(expected, f, indent=1, sort_keys=True)
    print(f"fixtures written to {os.path.normpath(out)}")


def write_zip64(path, name, content):
    import zlib

    nm = name.encode()
    crc = zlib.crc32(content)
    local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 45, 0, 0, 0, 0, crc, len(content), len(content), len(nm), 0)
    data = local + nm + content
    extra = struct.pack("<HHQQQ", 0x0001, 24, len(content), len(content), 0)
    central = (
        struct.pack(
            "<IHHHHHHIIIHHHHHII", 0x02014B50, 45, 45, 0, 0, 0, 0, crc,
            0xFFFFFFFF, 0xFFFFFFFF, len(nm), len(extra), 0, 0, 0, 0, 0xFFFFFFFF,
        )
        + nm
        + extra
    )
    cd_offset = len(data)
    eocd64_offset = cd_offset + len(central)
    eocd64 = struct.pack("<IQHHIIQQQQ", 0x06064B50, 44, 45, 45, 0, 0, 1, 1, len(central), cd_offset)
    locator = struct.pack("<IIQI", 0x07064B50, 0, eocd64_offset, 1)
    eocd = struct.pack("<IHHHHIIH", 0x06054B50, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)
    with open(path, "wb") as f:
        f.write(data + central + eocd64 + locator + eocd)


if __name__ == "__main__":
    main()
