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

async function main() {
  const expected = JSON.parse(await (await blob("expected.json")).text());
  for (const t of [testHashes, () => testZip(expected), () => testSparse(expected), testFlashConfig]) {
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
