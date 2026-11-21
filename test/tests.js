// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Unit tests against the fixtures of tools/make_test_fixtures.py, whose expected values
// come from Python (tools/sparse_digest.py), not from this code.

import { Crc32 } from "../js/crc32.js";
import { Sha256 } from "../js/sha256.js";
import { ByteReader, concatBytes } from "../js/bytes.js";
import { ZipFile } from "../js/zip.js";
import { parseSparseHeader, splitSparse, rawImageLayout, BlockDigest } from "../js/sparse.js";
import { parseFlashConfig, planFlashOps } from "../js/flash-config.js";
import { pdx246 } from "../js/device-pdx246.js";
import { xzDecompress, crc64 } from "../js/xz.js";
import { bzip2Decompress } from "../js/bzip2.js";
import { OtaPackage } from "../js/payload.js";
import { RangeFile } from "../js/mock-files.js";
import { buildSuperEmpty, parseSuperImage } from "../js/lp-metadata.js";

const FIX = "fixtures/";
const params = new URLSearchParams(location.search);
const results = [];
const out = document.getElementById("out");

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  const line = document.createElement("div");
  line.className = ok ? "ok" : "fail";
  line.textContent = `${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`;
  out.appendChild(line);
}

async function blob(name) {
  const r = await fetch(FIX + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.blob();
}

const sha = (u8) => new Sha256().update(u8).hex();
const enc = (s) => new TextEncoder().encode(s);

async function testHashes() {
  check("crc32 123456789", new Crc32().update(enc("123456789")).digest() === 0xcbf43926);
  check("crc32 empty", new Crc32().digest() === 0);
  const big = new Uint8Array(1000003).map((_, i) => (i * 7) & 0xff);
  const split = new Crc32().update(big.subarray(0, 333)).update(big.subarray(333)).digest();
  check("crc32 split update", split === new Crc32().update(big).digest());
  check("sha256 abc", sha(enc("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  check("sha256 empty", sha(new Uint8Array(0)) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  check(
    "sha256 448 bits",
    sha(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")) ===
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  const a = new Uint8Array(1000000).fill(0x61);
  check("sha256 million a", sha(a) === "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  const s = new Sha256();
  for (let i = 0; i < a.length; i += 977) s.update(a.subarray(i, i + 977));
  check("sha256 million a in odd pieces", s.hex() === "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

async function testZip(expected) {
  for (const [file, want] of [["test.zip", expected.zip], ["zip64.zip", expected.zip64]]) {
    const zip = await ZipFile.open(await blob(file));
    const files = zip.entries.filter((e) => !e.isDirectory);
    check(`${file}: entry count`, files.length === Object.keys(want).length, `${files.length}`);
    for (const e of files) {
      const w = want[e.name];
      const data = await zip.bytes(e);
      const crc = new Crc32().update(data).digest();
      check(
        `${file}: ${e.name} (method ${e.method})`,
        w && data.length === w.size && sha(data) === w.sha256 && crc === e.crc32 && e.size === w.size,
      );
    }
    check(`${file}: imageFiles() by base name`, zip.imageFiles().size === files.length);
  }
  let threw = false;
  try {
    await ZipFile.open(new Blob([new Uint8Array(100)]));
  } catch {
    threw = true;
  }
  check("not a zip is refused", threw);
}

async function split(name, maxSize, upload) {
  const b = await blob(name);
  const head = new Uint8Array(await b.slice(0, 28).arrayBuffer());
  const sparse = parseSparseHeader(head);
  const reader = new ByteReader(b.stream());
  let layout;
  if (sparse) {
    await reader.read(sparse.fileHeaderSize);
    layout = sparse;
  } else {
    layout = rawImageLayout(b.size);
  }
  const digest = new BlockDigest(layout.blockSize);
  let pieces = 0;
  let maxSeen = 0;
  let valid = true;
  for await (const p of splitSparse(reader, layout, maxSize)) {
    const data = concatBytes(p.parts, p.size);
    maxSeen = Math.max(maxSeen, data.length);
    const h = parseSparseHeader(data);
    if (!h || h.totalBlocks !== layout.totalBlocks || data.length !== p.size) valid = false;
    digest.applySparse(data);
    if (upload) {
      await fetch(`/upload/${name}-${maxSize}-${pieces}.simg`, { method: "PUT", body: data });
    }
    pieces++;
  }
  const atEnd = await reader.atEnd();
  return { digest: digest.hex(), blocks: digest.blocks, pieces, maxSeen, valid, atEnd };
}

async function testSparse(expected) {
  check("non-sparse header gives null", parseSparseHeader(new Uint8Array(28)) === null);
  const sizes = [4160, 5000, 9000, 20000, 65536, 300000, 4 << 20];
  const upload = params.has("upload");
  for (const name of ["sparse-1.img", "sparse-2.img", "sparse-3.img", "sparse-4.img", "raw-1.img"]) {
    const want = expected.sparse[name];
    for (const max of sizes) {
      const r = await split(name, max, upload && (max === 9000 || max === 65536));
      check(
        `split ${name} at ${max}`,
        r.valid && r.atEnd && r.maxSeen <= max && r.digest === want.digest && r.blocks === want.blocks,
        `${r.pieces} pieces, largest ${r.maxSeen}`,
      );
    }
  }
  let threw = false;
  try {
    await split("sparse-4.img", 4159, false);
  } catch {
    threw = true;
  }
  check("split below the minimum size is refused", threw);
}

async function testFlashConfig() {
  const text = await (await blob("flash-config.sh")).text();
  const cfg = parseFlashConfig(text);
  check("VALID_PRODUCTS", JSON.stringify(cfg.products) === JSON.stringify(["pdx246", "XQ-ES54", "XQ-ES72"]));
  check("FLASH_OPS count", cfg.ops.length === 10, `${cfg.ops.length}`);
  check("FLASH_OPS first", cfg.ops[0] === "getvar_fail_if secure yes");
  check("GETVAR_ERROR_secure", /reports secure=yes/.test(cfg.vars.GETVAR_ERROR_secure || ""));
  check("FLASH_COMPLETED_MESSAGE", /^\s*Flashing completed\./.test(cfg.vars.FLASH_COMPLETED_MESSAGE || ""));

  const images = new Map(
    ["vendor_dlkm.img", "sailfish.img001", "hybris-boot.img", "vendor_boot.img", "dtbo.img"].map((n) => [n, { size: 1 }]),
  );
  const plan = planFlashOps(cfg, pdx246, images);
  check("plan has no problems", plan.problems.length === 0, plan.problems.join("; "));
  check("plan checks", plan.checks.length === 1 && plan.checks[0].name === "secure" && plan.checks[0].value === "yes");
  const kinds = plan.ops.map((o) =>
    o.kind === "flash" ? `flash ${o.partition}${o.retries ? "*" : ""}` : o.kind === "reboot" ? `reboot ${o.target}` : o.kind,
  );
  const want = [
    "set-active", "script", "flash vendor_dlkm_a*", "flash userdata", "reboot bootloader",
    "flash boot_a*", "flash vendor_boot_a", "flash dtbo_a", "set-active",
  ];
  check("plan operations", JSON.stringify(kinds) === JSON.stringify(want), kinds.join(", "));

  const bad = parseFlashConfig(
    'FLASH_OPS=(\n"flash xbl_a xbl.img"\n"flash_blob oem_a *.img"\n"run rm -rf /"\n"run fastboot oem unlock"\n"flash boot_a missing.img"\n)\nVALID_PRODUCTS=("pdx246")',
  );
  const badPlan = planFlashOps(bad, pdx246, images);
  check("unsupported operations are refused", badPlan.problems.length === 6, badPlan.problems.join("; "));
}

async function bytesOf(name) {
  return new Uint8Array(await (await blob(name)).arrayBuffer());
}

// Every fixture decompresses to the original; damaged copies are refused.
async function testDecompressor(kind, decompress, table) {
  let inBytes = 0;
  let outBytes = 0;
  let ms = 0;
  for (const [name, want] of Object.entries(table)) {
    const input = await bytesOf(`${kind}/${name}`);
    let ok = false;
    let detail = "";
    try {
      const t0 = performance.now();
      const out = decompress(input);
      ms += performance.now() - t0;
      inBytes += input.length;
      outBytes += out.length;
      ok = out.length === want.size && sha(out) === want.sha256;
      if (!ok) detail = `${out.length} bytes`;
    } catch (e) {
      detail = e.message;
    }
    check(`${kind} ${name}`, ok, detail);
  }
  check(`${kind} speed`, true, `${(outBytes / 1e6 / (ms / 1000)).toFixed(0)} MB/s out, ${(inBytes / 1e6).toFixed(1)} MB in`);

  // Damage: flip a byte in the middle, cut the end. Both must fail, never return data.
  // (Only files with a checksum: without one, a changed stored byte cannot be noticed.)
  const damaged = Object.keys(table).filter((n) => /^(text|mixed|runs)\./.test(n) && !n.includes(".payload."));
  for (const name of damaged.slice(0, 6)) {
    const input = await bytesOf(`${kind}/${name}`);
    const flipped = input.slice();
    flipped[flipped.length >> 1] ^= 0x10;
    for (const [what, bad] of [["flipped byte", flipped], ["cut short", input.subarray(0, input.length - 7)]]) {
      let threw = false;
      try {
        decompress(bad);
      } catch {
        threw = true;
      }
      check(`${kind} ${name}: ${what} is refused`, threw);
    }
  }
  // An output limit is enforced.
  let limited = false;
  try {
    decompress(await bytesOf(`${kind}/${Object.keys(table).find((n) => n.startsWith("zeros."))}`), 1000);
  } catch {
    limited = true;
  }
  check(`${kind} output limit`, limited);
}

async function testXz(expected) {
  const [lo, hi] = crc64(enc("123456789"));
  check("crc64 123456789", lo === 0xdf1939fa && hi === 0x995dc9bb, `${hi.toString(16)}${lo.toString(16)}`);
  await testDecompressor("xz", xzDecompress, expected.xz);
}

async function testBzip2(expected) {
  await testDecompressor("bz2", bzip2Decompress, expected.bz2);
}

// Payloads built by tools/make_test_fixtures.py: every partition unpacks to its checksum,
// as one stream and as sparse pieces of several sizes (whose block digest has to match
// Python's), blocks of one repeated value become FILL chunks, and damage is caught.
async function testPayload(expected) {
  const zipBytes = await bytesOf("test-ota.zip");
  const pkg = await OtaPackage.open(new Blob([zipBytes]));
  const want = expected.ota["test-ota.zip"];
  const names = [...pkg.partitions.keys()];
  check("payload: partitions", names.slice().sort().join(" ") === Object.keys(want).sort().join(" "), names.join(" "));
  const g = pkg.manifest.dynamic.groups[0];
  check("payload: dynamic partition group", g && g.name === "somc_dynamic_partitions" && g.partitions.join(" ") === "system vendor");
  for (const [name, w] of Object.entries(want)) {
    const p = pkg.partition(name);
    let ok = true;
    try {
      await p.verify();
    } catch (e) {
      ok = false;
      check(`payload ${name}: verify`, false, e.message);
    }
    if (ok) check(`payload ${name}: verify`, true);
    const s = new Sha256();
    let n = 0;
    const reader = p.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      s.update(value);
      n += value.length;
    }
    check(`payload ${name}: stream`, n === w.size && s.hex() === w.sha256);
    for (const max of [9000, 65536, 300000, 4 << 20]) {
      const digest = new BlockDigest(p.blockSize);
      let pieces = 0;
      let largest = 0;
      let fills = 0;
      for await (const piece of splitSparse(null, { blockSize: p.blockSize, totalBlocks: p.totalBlocks }, max, p.chunks())) {
        const data = concatBytes(piece.parts, piece.size);
        largest = Math.max(largest, data.length);
        digest.applySparse(data);
        pieces++;
      }
      for await (const c of p.chunks()) if (c.type === 0xcac2) fills++;
      check(
        `payload ${name}: sparse pieces at ${max}`,
        digest.hex() === w.block_digest && digest.blocks === p.totalBlocks && largest <= max,
        `${pieces} pieces, ${fills} fill chunks`,
      );
    }
  }
  let fills = 0;
  for await (const c of pkg.partition("system").chunks()) if (c.type === 0xcac2) fills++;
  check("payload: zeros, gaps and the 0xaabbccdd pattern are fill chunks", fills >= 5, `${fills}`);
  const head = await pkg.partition("vbmeta").head(128);
  check("payload: vbmeta head", String.fromCharCode(...head.subarray(0, 4)) === "AVB0" && new DataView(head.buffer).getUint32(120) === 3);

  // One changed byte in an operation's data: the operation's checksum catches it.
  const sys = pkg.partition("system");
  const op = sys.ops.find((o) => o.type === 8);
  const bad = zipBytes.slice();
  bad[pkg.dataStart + op.dataOffset + Math.floor(op.dataLength / 2)] ^= 0x01;
  let caught = "";
  try {
    await (await OtaPackage.open(new Blob([bad]))).partition("system").verify();
  } catch (e) {
    caught = e.message;
  }
  check("payload: damaged operation data is refused", /damaged/.test(caught), caught);
  // A changed manifest: the metadata checksum in payload_properties.txt catches it.
  const badManifest = zipBytes.slice();
  badManifest[pkg.dataStart - 300] ^= 0x01;
  caught = "";
  try {
    await OtaPackage.open(new Blob([badManifest]));
  } catch (e) {
    caught = e.message;
  }
  check("payload: damaged manifest is refused", caught !== "", caught);

  const e2e = await OtaPackage.open(new Blob([await bytesOf("e2e-ota.zip")]));
  const all = expected.ota["e2e-ota.zip"];
  let bad2 = [];
  for (const [name, w] of Object.entries(all)) {
    const p = e2e.partition(name);
    try {
      await p.verify();
      if (p.sha256 !== w.sha256) bad2.push(name);
    } catch (e) {
      bad2.push(`${name}: ${e.message}`);
    }
  }
  check("payload: e2e-ota.zip verifies", bad2.length === 0 && e2e.partitions.size === 12, bad2.join("; "));
}

// The super partition's table: the same bytes as tools/lp_metadata.py for every layout
// (and, if linked, as the LineageOS build's own super.img without its extents), read back
// with liblp's checks, and damage refused.
async function testLp(expected) {
  for (const [name, want] of Object.entries(expected.lp)) {
    if (!want.layout) continue;
    const mine = buildSuperEmpty(want.layout);
    check(`lp ${name}: same bytes as Python`, sha(mine) === want.sha256 && mine.length === want.size, `${mine.length} bytes`);
    const t = parseSuperImage(await bytesOf(`lp/${name}.img`));
    check(
      `lp ${name}: reads back`,
      t.version === want.version &&
        t.blockDevices[0].firstLogicalSector === want.first_logical_sector &&
        t.partitions.length === want.layout.partitions.length &&
        t.groups.length === want.layout.groups.length + 1,
      `${t.version}, first sector ${t.blockDevices[0].firstLogicalSector}`,
    );
  }
  if (expected.lp["real-emptied"]) {
    const mine = buildSuperEmpty(expected.lp.pdx246.layout);
    check("lp pdx246: same as the LineageOS build's table without extents", sha(mine) === expected.lp["real-emptied"].sha256);
  }
  const good = await bytesOf("lp/pdx246.img");
  for (const [what, at] of [["geometry", 44], ["header", 4096 + 6], ["tables", 4096 + 256 + 10], ["last byte", good.length - 1]]) {
    const bad = good.slice();
    bad[at] ^= 1;
    let threw = false;
    try {
      parseSuperImage(bad);
    } catch {
      threw = true;
    }
    check(`lp: damaged ${what} is refused`, threw);
  }
  let threw = false;
  try {
    buildSuperEmpty({ ...expected.lp.pdx246.layout, deviceSize: 1 << 20 });
  } catch {
    threw = true;
  }
  check("lp: a super partition too small for its metadata is refused", threw);
}

// With ?only=realota: the real LineageOS OTA zip, linked as fixtures/real-lineage/ (see
// README). Every partition is unpacked and checked against the payload's SHA-256.
async function testRealOta() {
  const file = await RangeFile.open(`${FIX}real-lineage/lineage-23.2-20260924-UNOFFICIAL-pdx246.zip`);
  const t0 = performance.now();
  const pkg = await OtaPackage.open(file);
  const names = [...pkg.partitions.keys()];
  check("real OTA: opened", names.length === 12, `${names.join(" ")}, ${Math.round(performance.now() - t0)} ms`);
  check("real OTA: pre-device", (pkg.metadata["pre-device"] || "").split("|").includes("pdx246"), pkg.metadata["pre-device"]);
  const group = pkg.manifest.dynamic.groups[0];
  check("real OTA: dynamic partitions", group.name === "somc_dynamic_partitions" && group.partitions.length === 6, group.partitions.join(" "));
  const release = pdx246.lineage.releases.find((r) => r.tag === "v23.2-20260924");
  for (const [name, img] of Object.entries(release.images)) {
    const p = pkg.partition(name.replace(".img", ""));
    if (name !== "recovery.img") check(`real OTA: ${name} is the release's`, p && p.sha256 === img.sha256);
  }
  let total = 0;
  let ms = 0;
  for (const name of names) {
    const p = pkg.partition(name);
    const t = performance.now();
    let ok = true;
    let detail = "";
    try {
      await p.verify();
    } catch (e) {
      ok = false;
      detail = e.message;
    }
    const dt = performance.now() - t;
    ms += dt;
    total += p.size;
    check(`real OTA: ${name} unpacks to its checksum`, ok, detail || `${(p.size / 1e6).toFixed(0)} MB in ${(dt / 1000).toFixed(1)} s`);
  }
  check("real OTA: speed", true, `${(total / 1e9).toFixed(2)} GB in ${(ms / 1000).toFixed(0)} s, ${(total / 1e6 / (ms / 1000)).toFixed(0)} MB/s`);
}

async function main() {
  const expected = JSON.parse(await (await blob("expected.json")).text());
  const only = params.get("only");
  const all = {
    hashes: testHashes,
    zip: () => testZip(expected),
    sparse: () => testSparse(expected),
    flashconfig: testFlashConfig,
    xz: () => testXz(expected),
    bzip2: () => testBzip2(expected),
    lp: () => testLp(expected),
    payload: () => testPayload(expected),
    realota: testRealOta,
  };
  const optional = ["realota"]; // only when asked for: needs the linked real files
  const selected = Object.entries(all).filter(([k]) => (only ? only.split(",").includes(k) : !optional.includes(k)));
  for (const [, t] of selected) {
    try {
      await t();
    } catch (e) {
      check(`exception: ${e.message}`, false);
      console.error(e);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const summary = document.getElementById("summary");
  summary.className = failed ? "fail" : "ok";
  summary.textContent = `${results.length - failed} of ${results.length} tests passed.`;
  window.__testResults = { passed: results.length - failed, failed, results };
}

main();
