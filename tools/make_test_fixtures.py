#!/usr/bin/env python3
# SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
# SPDX-License-Identifier: BSD-3-Clause
"""Writes the synthetic fixtures for test/index.html into test/fixtures/ (not committed).

- sparse-*.img: sparse images with RAW, FILL, DONT_CARE and CRC32 chunks, including RAW
  chunks far larger than the split sizes the tests use, and raw-1.img (not sparse);
- test.zip: stored, deflated and ZIP64 entries in one top-level folder, and a directory;
- xz/, bz2/: data compressed by Python's lzma and bz2 (and the xz tool, for multi-block
  files) in many variants, to check the page's own decompressors;
- expected.json: the reference digests (tools/sparse_digest.py) and entry checksums.
"""
import bz2
import hashlib
import json
import lzma
import os
import random
import shutil
import struct
import subprocess
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lp_metadata  # noqa: E402
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

    expected["xz"], expected["bz2"] = compression_fixtures(out, rnd)
    expected["lp"] = lp_fixtures(out)
    expected["ota"] = ota_fixtures(out, rnd)

    with open(os.path.join(out, "expected.json"), "w") as f:
        json.dump(expected, f, indent=1, sort_keys=True)
    print(f"fixtures written to {os.path.normpath(out)}")


# Layouts for the super partition's table; js/lp-metadata.js has to build the same bytes.
PDX246_NAMES = ["system", "vendor", "vendor_dlkm", "system_ext", "odm", "product"]
LP_LAYOUTS = {
    # As the pdx246 build writes super_empty.img (Virtual A/B: header 10.2, three slots).
    "pdx246": dict(
        deviceSize=17179869184, virtualAb=True,
        groups=[{"name": f"somc_dynamic_partitions{s}", "maxSize": 17175674880} for s in ("_a", "_b")],
        partitions=[{"name": n + s, "group": f"somc_dynamic_partitions{s}", "attributes": 0} for n in PDX246_NAMES for s in ("_a", "_b")],
    ),
    # Plain A/B, read-only attributes: header 10.0.
    "ab": dict(
        deviceSize=8 << 30, metadataSlots=2,
        groups=[{"name": "main", "maxSize": (8 << 30) - (4 << 20)}],
        partitions=[{"name": n, "group": "main", "attributes": 1} for n in ("system", "vendor", "product")],
    ),
    # An UPDATED attribute needs 10.1; small, unaligned sizes.
    "updated": dict(
        deviceSize=64 << 20, metadataMaxSize=6000, metadataSlots=2, alignment=4096,
        groups=[{"name": "g1", "maxSize": 0}, {"name": "g2", "maxSize": 12345678}],
        partitions=[{"name": "a", "group": "g1", "attributes": 1}, {"name": "b", "group": "g2", "attributes": 4}],
    ),
}


def lp_fixtures(out):
    d = os.path.join(out, "lp")
    os.makedirs(d, exist_ok=True)
    expected = {}
    for name, lay in LP_LAYOUTS.items():
        blob = lp_metadata.build_super_empty(
            lay["deviceSize"],
            [(g["name"], g["maxSize"]) for g in lay["groups"]],
            [(p["name"], p["group"], p["attributes"]) for p in lay["partitions"]],
            metadata_max_size=lay.get("metadataMaxSize", 65536), slots=lay.get("metadataSlots", 3),
            alignment=lay.get("alignment", 1 << 20), virtual_ab=lay.get("virtualAb", False),
        )
        table = lp_metadata.read(blob)
        with open(os.path.join(d, f"{name}.img"), "wb") as f:
            f.write(blob)
        expected[name] = {
            "layout": lay, "sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob),
            "version": "%d.%d" % table["version"], "first_logical_sector": table["devices"][0][0],
        }
    # The table of the LineageOS build's own super.img, without its extents, if it is linked
    # (test/fixtures/real-lineage/super.img): the pdx246 layout has to come out the same.
    real = os.path.join(out, "real-lineage", "super.img")
    if os.path.exists(real):
        blob = lp_metadata.emptied(lp_metadata.read(lp_metadata.table_from_super(real)))
        with open(os.path.join(d, "real-emptied.img"), "wb") as f:
            f.write(blob)
        expected["real-emptied"] = {"sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob)}
    return expected


# ---------------------------------------------------------------- OTA payloads

def pb_varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pb_uint(field, v):
    return pb_varint(field << 3) + pb_varint(v)


def pb_bytes(field, b):
    return pb_varint((field << 3) | 2) + pb_varint(len(b)) + b


def build_payload(partitions, groups, bs=4096, preset=6):
    """partitions: [(name, image bytes, [(kind, [(start, blocks), ...]), ...])], kinds REPLACE,
    BZ, XZ, ZERO. Returns payload.bin as update_engine's full payloads lay it out."""
    blobs = bytearray()
    parts_pb = b""
    for name, image, plan in partitions:
        ops_pb = b""
        for kind, extents in plan:
            data = b"".join(image[s * bs:(s + n) * bs] for s, n in extents)
            op = b""
            if kind == "ZERO":
                assert data == bytes(len(data)), name
                op += pb_uint(1, 6)
            else:
                if kind == "REPLACE":
                    blob = data.rstrip(b"\0") or data[:1]  # shorter than its blocks: padded with zeros
                    op += pb_uint(1, 0)
                elif kind == "BZ":
                    blob = bz2.compress(data, 9)
                    op += pb_uint(1, 1)
                else:
                    blob = lzma.compress(data, format=lzma.FORMAT_XZ, check=lzma.CHECK_NONE, preset=preset)
                    op += pb_uint(1, 8)
                op += pb_uint(2, len(blobs)) + pb_uint(3, len(blob)) + pb_bytes(8, hashlib.sha256(blob).digest())
                blobs += blob
            for s, n in extents:
                op += pb_bytes(6, pb_uint(1, s) + pb_uint(2, n))
            ops_pb += pb_bytes(8, op)
        info = pb_uint(1, len(image)) + pb_bytes(2, hashlib.sha256(image).digest())
        parts_pb += pb_bytes(13, pb_bytes(1, name.encode()) + pb_bytes(7, info) + ops_pb)
    dyn = b"".join(
        pb_bytes(1, pb_bytes(1, g.encode()) + pb_uint(2, size) + b"".join(pb_bytes(3, p.encode()) for p in members))
        for g, size, members in groups
    ) + pb_uint(2, 1)
    signature = pb_bytes(1, pb_bytes(2, bytes(256)))  # placeholder signatures (not checked)
    manifest = pb_uint(3, bs) + pb_uint(4, len(blobs)) + pb_uint(5, len(signature)) + pb_uint(12, 0) + parts_pb + pb_bytes(15, dyn)
    header = b"CrAU" + struct.pack(">QQI", 2, len(manifest), len(signature))
    return header + manifest + signature + bytes(blobs) + signature, len(header) + len(manifest)


def write_ota(path, payload, metadata_size, device="pdx246|XQ-ES54|XQ-ES72", sdk=36):
    import base64

    b64 = lambda b: base64.b64encode(hashlib.sha256(b).digest()).decode()  # noqa: E731
    props = f"FILE_HASH={b64(payload)}\nFILE_SIZE={len(payload)}\nMETADATA_HASH={b64(payload[:metadata_size])}\nMETADATA_SIZE={metadata_size}\n"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("META-INF/com/android/metadata", f"ota-type=AB\npost-sdk-level={sdk}\npre-device={device}\n")
        z.writestr(zipfile.ZipInfo("payload.bin"), payload)  # stored, as in real packages
        z.writestr("payload_properties.txt", props)


def chunked(blocks, size, kinds):
    """Operations of `size` blocks over [0, blocks), their kinds taken in turn from `kinds`."""
    return [(kinds[i % len(kinds)], [(s, min(size, blocks - s))]) for i, s in enumerate(range(0, blocks, size))]


def textish(rnd, n):
    words = [rnd.randbytes(rnd.randint(1, 6)).hex().encode() for _ in range(500)]
    out = bytearray()
    while len(out) < n:
        out += rnd.choice(words) + b" "
    return bytes(out[:n])


def ota_fixtures(out, rnd):
    bs = 4096
    expected = {}

    def describe(partitions):
        e = {}
        for name, image, _ in partitions:
            e[name] = {
                "size": len(image),
                "sha256": hashlib.sha256(image).hexdigest(),
                "block_digest": sparse_digest.digest(lambda: __import__("io").BytesIO(image), len(image), blocks_for_raw=True)["digest"],
            }
        return e

    # test-ota.zip: small partitions covering every case the page handles.
    sysimg = bytearray(textish(rnd, 400 * bs))
    sysimg[40 * bs:80 * bs] = bytes(40 * bs)  # a ZERO operation
    sysimg[100 * bs:110 * bs] = b"\xaa\xbb\xcc\xdd" * (10 * bs // 4)  # a fill pattern inside data
    sysimg[200 * bs:204 * bs] = bytes(4 * bs)  # a gap no operation covers
    sysimg[300 * bs:310 * bs] = bytes(10 * bs)  # zero blocks inside compressed data
    system_plan = (
        [("XZ", [(0, 40)]), ("ZERO", [(40, 40)]), ("BZ", [(80, 60)]), ("REPLACE", [(140, 30)]), ("XZ", [(170, 30)])]
        + [("XZ", [(204, 20), (230, 26)])]  # one operation with two extents
        + [("BZ", [(256, 144)])]
    )
    sysimg[224 * bs:230 * bs] = bytes(6 * bs)  # between those two extents: not covered, so zeros
    boot = textish(rnd, 100 * bs) + bytes(28 * bs)
    boot = boot[:-1000] + bytes(1000)
    vbmeta = bytearray(2 * bs)
    vbmeta[0:4] = b"AVB0"
    vbmeta[120:124] = struct.pack(">I", 3)
    small = [
        ("boot", boot, chunked(128, 64, ["XZ", "REPLACE"])),
        ("system", bytes(sysimg), system_plan),
        ("vendor", bytes(64 * bs), chunked(64, 32, ["BZ"])),
        ("vbmeta", bytes(vbmeta), [("XZ", [(0, 2)])]),
    ]
    payload, msize = build_payload(small, [("somc_dynamic_partitions", 17175674880, ["system", "vendor"])])
    write_ota(os.path.join(out, "test-ota.zip"), payload, msize)
    expected["test-ota.zip"] = describe(small)

    # e2e-ota.zip: the twelve partitions of the pdx246 payload, small, for the simulated
    # installation (index.html?mock=1&testlineageota=...).
    def image(blocks, zero_tail=0, fill=0):
        data = bytearray(textish(rnd, blocks * bs))
        if fill:
            data[(blocks // 2) * bs:(blocks // 2 + fill) * bs] = b"\x5a" * (fill * bs)
        if zero_tail:
            data[(blocks - zero_tail) * bs:] = bytes(zero_tail * bs)
        return bytes(data)

    def plan(img):
        blocks = len(img) // bs
        ops = []
        for s in range(0, blocks, 512):
            n = min(512, blocks - s)
            chunk = img[s * bs:(s + n) * bs]
            ops.append(("BZ" if chunk == bytes(len(chunk)) else "XZ", [(s, n)]))
        return ops

    avb = bytearray(8192)
    avb[0:4] = b"AVB0"
    avb[120:124] = struct.pack(">I", 3)
    avb_system = bytearray(4096)
    avb_system[0:4] = b"AVB0"
    images = {
        "boot": image(2048, zero_tail=1200),
        "dtbo": image(256, zero_tail=100),
        "odm": image(100),
        "product": image(4096, zero_tail=3000),  # mostly free space, like the real one
        "recovery": image(1536, zero_tail=600),
        "system": image(6144, fill=300),
        "system_ext": image(1536),
        "vbmeta": bytes(avb),
        "vbmeta_system": bytes(avb_system),
        "vendor": image(3072, zero_tail=200),
        "vendor_boot": image(1024, zero_tail=400),
        "vendor_dlkm": image(1024),
    }
    e2e = [(n, img, plan(img)) for n, img in images.items()]
    payload, msize = build_payload(e2e, [("somc_dynamic_partitions", 17175674880, PDX246_NAMES)], preset=1)
    write_ota(os.path.join(out, "e2e-ota.zip"), payload, msize)
    expected["e2e-ota.zip"] = describe(e2e)
    return expected


def sample_data(rnd):
    """Inputs that reach the decoders' different paths."""
    words = [rnd.randbytes(rnd.randint(2, 9)).hex() for _ in range(300)]
    text = " ".join(rnd.choice(words) for _ in range(60000)).encode()
    runs = b"".join(bytes([rnd.randrange(256)]) * rnd.choice([1, 2, 3, 4, 5, 6, 255, 256, 259, 260, 600]) for _ in range(4000))
    mixed = b"".join(
        rnd.choice([lambda: rnd.randbytes(70000), lambda: text[:90000], lambda: bytes(130000)])() for _ in range(30)
    )
    return {
        "empty": b"",
        "one": b"x",
        "text": text,  # matches of all lengths and distances
        "zeros": bytes(3 << 20),  # several LZMA2 chunks; bzip2 run lengths
        "random": rnd.randbytes(300000),  # incompressible: LZMA2 stores it uncompressed
        "mixed": mixed,  # LZMA2 switches between compressed and uncompressed chunks
        "runs": runs,  # bzip2's four-bytes-and-a-count coding at its edges
        "allbytes": bytes(range(256)) * 4096,
    }


def compression_fixtures(out, rnd):
    data = sample_data(rnd)
    xz_dir = os.path.join(out, "xz")
    bz_dir = os.path.join(out, "bz2")
    os.makedirs(xz_dir, exist_ok=True)
    os.makedirs(bz_dir, exist_ok=True)
    xz_expected = {}
    bz_expected = {}

    def put(directory, table, name, blob, source):
        with open(os.path.join(directory, name), "wb") as f:
            f.write(blob)
        table[name] = {"size": len(source), "sha256": hashlib.sha256(source).hexdigest()}

    variants = {
        # As Android's payload generator writes them: no check, LZMA2 preset 6.
        "payload": dict(check=lzma.CHECK_NONE, preset=6),
        "crc32-p0": dict(check=lzma.CHECK_CRC32, preset=0),
        "crc64-p9e": dict(check=lzma.CHECK_CRC64, preset=9 | lzma.PRESET_EXTREME),
        "sha256-p3": dict(check=lzma.CHECK_SHA256, preset=3),
        # Unusual literal and position settings, and a small dictionary (long distances fail).
        "lc0-lp2-pb0": dict(check=lzma.CHECK_CRC32, filters=[{"id": lzma.FILTER_LZMA2, "preset": 6, "lc": 0, "lp": 2, "pb": 0}]),
        "lc4-pb4": dict(check=lzma.CHECK_CRC32, filters=[{"id": lzma.FILTER_LZMA2, "preset": 6, "lc": 4, "lp": 0, "pb": 4}]),
        "dict4k": dict(check=lzma.CHECK_CRC64, filters=[{"id": lzma.FILTER_LZMA2, "preset": 6, "dict_size": 4096}]),
    }
    for dname, source in data.items():
        for vname, kw in variants.items():
            if dname in ("zeros", "allbytes") and vname not in ("payload", "crc32-p0"):
                continue
            put(xz_dir, xz_expected, f"{dname}.{vname}.xz", lzma.compress(source, format=lzma.FORMAT_XZ, **kw), source)
    # Several streams with stream padding in between.
    a, b = data["text"][:50000], data["random"][:20000]
    multi = lzma.compress(a, check=lzma.CHECK_CRC32) + bytes(8) + lzma.compress(b) + bytes(4)
    put(xz_dir, xz_expected, "multi-stream.xz", multi, a + b)
    # Several blocks in one stream, which only the xz tool writes.
    if shutil.which("xz"):
        blob = subprocess.run(
            ["xz", "-c", "--block-size=100000", "--check=crc32", "-6"], input=data["mixed"], capture_output=True, check=True
        ).stdout
        put(xz_dir, xz_expected, "mixed.blocks.xz", blob, data["mixed"])

    for dname, source in data.items():
        for level in (1, 9):
            put(bz_dir, bz_expected, f"{dname}.{level}.bz2", bz2.compress(source, level), source)
    a, b = data["runs"][:100000], data["text"][:40000]
    put(bz_dir, bz_expected, "multi-stream.bz2", bz2.compress(a, 1) + bz2.compress(b, 9), a + b)
    return xz_expected, bz_expected


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
