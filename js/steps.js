// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// The operations of an installation, with the semantics of flash.sh and host fastboot:
// flashing (resizing logical partitions first, splitting large images into sparse pieces),
// slot changes, restarts with the reconnects they need, and the initial checks.

import { ByteReader, readInParts, sleep, tap, formatSize } from "./bytes.js";
import { Crc32 } from "./crc32.js";
import { parseSparseHeader, splitSparse, rawImageLayout } from "./sparse.js";
import { MODE_LABELS } from "./connection.js";

const FLASH_TIMEOUT = 120000;

export class StepError extends Error {
  constructor(title, advice) {
    super(title);
    this.name = "StepError";
    this.advice = advice;
  }
}

// An image inside the Sailfish OS zip.
export function zipImage(zip, entry, name) {
  return { name, size: entry.size, crc32: entry.crc32, open: () => zip.stream(entry) };
}

// An image file chosen on its own (the LineageOS images).
export function fileImage(file) {
  return { name: file.name, size: file.size, crc32: null, open: async () => file.stream() };
}

async function readHead(image, n) {
  const reader = new ByteReader(await image.open());
  try {
    return (await reader.read(Math.min(n, image.size))).slice();
  } finally {
    await reader.cancel();
  }
}

export class Installer {
  constructor({ conn, profile, log, onWaiting, timeScale = 1 }) {
    this.conn = conn;
    this.profile = profile;
    this.log = log;
    this.onWaiting = onWaiting || (() => {});
    this.timeScale = timeScale;
    this.progress = () => {};
  }

  // The connected phone; if `mode` is given, it has to be in that mode.
  device(mode) {
    if (!this.conn.connected) throw new StepError("The phone is not connected.");
    if (mode && this.conn.mode !== mode) {
      throw new StepError(
        `The phone is in ${MODE_LABELS[this.conn.mode]}, but this step needs ${MODE_LABELS[mode]}.`,
      );
    }
    return this.conn.fb;
  }

  async waitForMode(mode, { slowAdvice } = {}) {
    this.onWaiting({ mode, slowAdvice, since: Date.now() });
    try {
      await this.conn.waitFor(mode);
    } finally {
      this.onWaiting(null);
    }
  }

  // reboot, reboot-bootloader or reboot-fastboot, then wait until the phone is back in the
  // mode asked for. The bootloader often resets USB before its answer arrives
  // ("usb_read failed" in host fastboot); like flash-preflight.sh, that alone is no error.
  async rebootTo(target, { slowAdvice } = {}) {
    const fb = this.device();
    const cmd = target ? `reboot-${target}` : "reboot";
    try {
      await fb.command(cmd, { timeoutMs: 10000 * this.timeScale });
    } catch (e) {
      if (e.kind === "fail") throw new StepError(`The phone refused to restart (${e.remote || "FAILED"}).`);
      this.log("   the answer to the restart got lost; that is harmless when the phone restarts");
    }
    const gone = await this.conn.waitForDisconnect(30000);
    await this.conn.release();
    if (!gone) {
      throw new StepError(
        "The phone did not restart.",
        "Unplug the USB cable, start the phone in fastboot mode again (power off, hold volume up while plugging in) and start over.",
      );
    }
    if (!target) return;
    await sleep(1000 * this.timeScale);
    await this.waitForMode(target === "fastboot" ? "fastbootd" : "bootloader", { slowAdvice });
  }

  async downloadLimit() {
    let limit = this.profile.maxDownloadSize;
    if (this.profile.queryMaxDownloadIn.includes(this.conn.mode)) {
      const v = await this.device().tryGetVar("max-download-size");
      // fastboot treats the value as hex, with or without 0x (util.cpp fb_fix_numeric_var).
      const n = v ? parseInt(v.replace(/^0x/i, ""), 16) : 0;
      if (n > 0) limit = Math.min(limit, n);
    }
    return limit;
  }

  // flash / flash_dont_fail: flash_dont_fail retries 30 times, a second apart.
  async flash(partition, image, { retries = 0 } = {}) {
    const mode = this.conn.mode;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.flashOnce(partition, image);
      } catch (e) {
        if (attempt >= retries || e instanceof StepError) throw e;
        this.log(`   writing ${partition} failed (${e.message}); trying again (${attempt + 1}/${retries})`);
        await sleep(1000 * this.timeScale);
        if (!this.conn.connected) await this.waitForMode(mode);
      }
    }
  }

  async flashOnce(partition, image) {
    const fb = this.device();
    const sparse = parseSparseHeader(await readHead(image, 28));
    const expanded = sparse ? sparse.totalBlocks * sparse.blockSize : image.size;

    // Host fastboot resizes a logical partition to the image size before writing it
    // (fastboot.cpp do_flash); logical partitions exist only in fastbootd.
    if (this.conn.mode === "fastbootd" && (await fb.tryGetVar(`is-logical:${partition}`)) === "yes") {
      await fb.command(`resize-logical-partition:${partition}:${expanded}`, { timeoutMs: 60000 });
    }

    const limit = await this.downloadLimit();
    const crc = image.crc32 != null ? new Crc32() : null;
    let stream = await image.open();
    if (crc) stream = stream.pipeThrough(tap(crc));
    const reader = new ByteReader(stream);
    try {
      if (image.size <= limit) {
        // Fits into one download: sent unchanged, as host fastboot does.
        await fb.download(readInParts(reader, image.size), image.size, (s) => this.progress(s, image.size));
        await fb.command(`flash:${partition}`, { timeoutMs: FLASH_TIMEOUT });
      } else {
        let layout;
        if (sparse) {
          await reader.read(sparse.fileHeaderSize);
          layout = sparse;
        } else {
          layout = rawImageLayout(image.size);
        }
        let n = 0;
        let done = 0;
        for await (const piece of splitSparse(reader, layout, limit)) {
          n++;
          this.log(`   ${image.name}: part ${n}, ${formatSize(piece.size)}`);
          await fb.download(piece.parts, piece.size, (s) => this.progress(Math.min(done + s, image.size), image.size));
          done += piece.size;
          await fb.command(`flash:${partition}`, { timeoutMs: FLASH_TIMEOUT });
        }
      }
      if (crc) {
        if (!(await reader.atEnd())) throw new StepError(`${image.name} is longer than the zip says.`);
        if (crc.digest() !== image.crc32) {
          throw new StepError(
            `${image.name} in the zip is damaged (checksum mismatch).`,
            "Download the zip again, then start over from the bootloader.",
          );
        }
      }
    } finally {
      await reader.cancel();
    }
  }

  // product (against VALID_PRODUCTS) and the getvar_fail_if checks, before anything changes.
  // The same queries in the same order as flash.sh, which the Sony bootloader answers well.
  async checkPhone(products, checks) {
    const fb = this.device("bootloader");
    const product = await fb.tryGetVar("product");
    const baseband = await fb.tryGetVar("version-baseband");
    const bootloader = await fb.tryGetVar("version-bootloader");
    this.log(`   found ${product}, baseband ${baseband}, bootloader ${bootloader}`);
    if (!products.includes(product)) {
      throw new StepError(
        `This phone reports itself as “${product}”, which this image is not made for.`,
        `The image is for: ${products.join(", ")}.`,
      );
    }
    for (const c of checks) {
      const v = await fb.tryGetVar(c.name);
      this.log(`   ${c.name}: ${v === null ? "(not supported)" : v}`);
      if (v === null) throw new StepError(`The phone does not report ${c.name}.`);
      if (v === c.value) throw new StepError(`The phone reports ${c.name}: ${v}.`, c.message);
    }
    return { product, baseband, bootloader };
  }

  async runOp(op, images) {
    switch (op.kind) {
      case "flash":
        return this.flash(op.partition, images.get(op.file), { retries: op.retries });
      case "set-active":
        await this.device().command(`set_active:${op.slot}`);
        return;
      case "reboot":
        return this.rebootTo(op.target);
      case "erase":
        await this.device().command(`erase:${op.partition}`, { timeoutMs: FLASH_TIMEOUT });
        return;
      case "sleep":
        return sleep(op.seconds * 1000 * this.timeScale);
      case "script":
        return this.profile.scripts[op.script](this, op.args);
      default:
        throw new StepError(`Unknown operation ${op.kind}.`);
    }
  }
}

export function describeOp(op, images, profile) {
  switch (op.kind) {
    case "flash": {
      const img = images.get(op.file);
      return `Write ${op.partition} (${op.file}, ${formatSize(img.size)})`;
    }
    case "set-active":
      return `Make slot ${op.slot} active`;
    case "reboot":
      if (op.target === "bootloader") return "Restart into the bootloader";
      if (op.target === "fastboot") return "Restart into fastbootd";
      return "Restart the phone";
    case "erase":
      return `Erase ${op.partition}`;
    case "sleep":
      return `Wait ${op.seconds} s`;
    case "script":
      return (profile.scripts[op.script] && profile.scripts[op.script].title) || `Run ${op.script}`;
    default:
      return op.kind;
  }
}
