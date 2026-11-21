// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Installing from Sony's Android: checking the LineageOS OTA zip, the stock phone and its
// firmware, unlocking the bootloader, and writing LineageOS to slot a straight from the zip:
// the boot images in the bootloader, the dynamic partitions in LineageOS's fastbootd after
// the table of super has been replaced with the build's empty one. The Sailfish OS
// installation follows as usual.

import { StepError } from "./steps.js";
import { OtaPackage } from "./payload.js";
import { buildSuperEmpty } from "./lp-metadata.js";
import { Sha256 } from "./sha256.js";
import { formatSize } from "./bytes.js";

// "70.2.A.4.22" -> [70, 2]; null for anything else.
export function firmwareVersion(s) {
  const m = /^(\d+)\.(\d+)\.[A-Z]\.\d+\.\d+$/.exec(s || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function firmwareAtLeast(s, min) {
  const v = firmwareVersion(s);
  return !!v && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));
}

// The unlock code as typed, without spaces or a leading 0x, in upper case.
export function normalizeUnlockCode(s) {
  return (s || "").replace(/\s+/g, "").replace(/^0x/i, "").toUpperCase();
}

// ---------------------------------------------------------------- the LineageOS zip

// Opens and checks an OTA zip for this flow: the device, the Android version, the partitions,
// and then every partition unpacked against its checksum. Any LineageOS 23.2 build passes;
// release is the tested release it is (by SHA-256), or null.
// onStatus(text) reports progress. Returns { pkg, release, sha256 }.
export async function checkLineageZip(file, profile, onStatus = () => {}) {
  onStatus("Reading the zip…");
  const pkg = await OtaPackage.open(file);
  const devices = (pkg.metadata["pre-device"] || "").split("|").filter(Boolean);
  if (!devices.includes(profile.codename)) {
    throw new Error(`This OTA zip is for ${devices.join(", ") || "an unknown device"}, not for the ${profile.name}.`);
  }
  const sdk = pkg.metadata["post-sdk-level"];
  if (sdk !== profile.lineage.sdkLevel) {
    throw new Error(
      `This zip installs Android SDK level ${sdk || "?"}, but Sailfish OS for the ${profile.name} runs on LineageOS 23.2 ` +
        `(Android 16, level ${profile.lineage.sdkLevel}). Use a LineageOS 23.2 zip, such as ${profile.lineage.releases[0].zip.file}.`,
    );
  }
  const st = profile.stock;
  const missing = [...st.physical.map(([src]) => src), ...st.logical].filter((n) => !pkg.partition(n));
  if (missing.length) throw new Error(`This OTA zip lacks the partitions ${missing.join(", ")}.`);
  const group = pkg.manifest.dynamic?.groups.find((g) => g.name === st.group);
  if (!group || group.partitions.slice().sort().join(" ") !== st.logical.slice().sort().join(" ")) {
    throw new Error("The dynamic partitions of this OTA zip are not those of the LineageOS build for this phone.");
  }

  const sha = new Sha256();
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    sha.update(value);
    done += value.length;
    onStatus(`Checking the zip (1 of 2): checksum, ${Math.floor((100 * done) / file.size)} %`);
  }
  const sha256 = sha.hex();
  const release = profile.lineage.releases.find((r) => r.zip.sha256 === sha256 && r.zip.size === file.size) || null;

  const names = [...st.physical.map(([src]) => src), ...group.partitions];
  const total = names.reduce((s, n) => s + pkg.partition(n).size, 0);
  let unpacked = 0;
  for (const [i, name] of names.entries()) {
    const p = pkg.partition(name);
    await p.verify((n) => {
      unpacked += n;
      onStatus(`Checking the zip (2 of 2): unpacking ${name} (${i + 1} of ${names.length}), ${Math.floor((100 * unpacked) / total)} %`);
    });
  }
  // Sailfish OS's boot image is not signed: vbmeta has to switch verification off (flags 3).
  const head = await pkg.partition("vbmeta").head(128);
  const isAvb = String.fromCharCode(...head.subarray(0, 4)) === "AVB0";
  if (!isAvb || (new DataView(head.buffer).getUint32(120) & 3) !== 3) {
    throw new Error("The vbmeta of this zip does not switch verification off, which Sailfish OS needs.");
  }
  return { pkg, release, sha256 };
}

// The empty table of super for this build: the payload's group, in both slots.
export function superTable(pkg, profile) {
  const st = profile.stock;
  const g = pkg.manifest.dynamic.groups.find((x) => x.name === st.group);
  return buildSuperEmpty({
    ...st.superLayout,
    virtualAb: st.superLayout.virtualAb && pkg.manifest.dynamic.snapshotEnabled,
    groups: ["_a", "_b"].map((s) => ({ name: g.name + s, maxSize: g.size })),
    partitions: g.partitions.flatMap((p) => ["_a", "_b"].map((s) => ({ name: p + s, group: g.name + s, attributes: 0 }))),
  });
}

// ---------------------------------------------------------------- the phone

// What the bootloader says about the phone, from getvar:all (where Sony's bootloader also
// reports the active slot), with single queries for anything missing there.
async function readBootloader(inst) {
  const fb = inst.device("bootloader");
  let all = new Map();
  try {
    all = await fb.getVarAll();
  } catch (e) {
    if (e.kind !== "fail") throw e;
  }
  const get = async (name) => (all.has(name) ? all.get(name) : await fb.tryGetVar(name));
  const info = {
    product: await get("product"),
    slot: ((await get("current-slot")) || "").replace(/^_/, "") || null,
    baseband: await get("version-baseband"),
    bootloader: await get("version-bootloader"),
    secure: await get("secure"),
    unlocked: await get("unlocked"),
  };
  info.locked = info.unlocked === "no" || (info.unlocked === null && info.secure === "yes");
  return info;
}

const NOTHING_CHANGED = "Nothing has been changed on the phone.";

// Step: the model, the active slot, the lock state and the firmware, before anything changes.
export async function checkStockPhone(inst, ctx) {
  const { profile } = inst;
  const info = await readBootloader(inst);
  ctx.first = info;
  ctx.stockSlot = info.slot;
  inst.log(
    `   found ${info.product}, slot ${info.slot}, firmware ${info.baseband}, bootloader ${info.bootloader}, ` +
      (info.locked ? "bootloader locked" : "bootloader unlocked"),
  );
  if (!profile.products.includes(info.product)) {
    throw new StepError(`This phone reports itself as “${info.product}”, not as an ${profile.name}.`, NOTHING_CHANGED);
  }
  if (info.slot !== "a" && info.slot !== "b") {
    throw new StepError("The bootloader does not say which slot is active.", NOTHING_CHANGED);
  }
  const min = profile.stock.minFirmware.join(".");
  if (!firmwareAtLeast(info.baseband, profile.stock.minFirmware)) {
    throw new StepError(
      `The phone has Sony's firmware ${info.baseband || "(unknown)"}; LineageOS 23.2 needs ${min} or newer.`,
      `Start the phone, install the newest software update in Settings, System, Software update, and start again. ${NOTHING_CHANGED}`,
    );
  }
  if (info.locked && !ctx.unlockCode) {
    throw new StepError("The bootloader is locked.", `Enter Sony's unlock code in step 2 and start again. ${NOTHING_CHANGED}`);
  }
}

// Step: Sony's unlock command, if the bootloader is locked. It erases the phone.
export async function unlockBootloader(inst, ctx) {
  if (!ctx.first.locked) {
    inst.log("   the bootloader is already unlocked");
    return;
  }
  const fb = inst.device("bootloader");
  const cmd = inst.profile.stock.unlockCommand(ctx.unlockCode);
  try {
    await fb.command(cmd, { timeoutMs: 120000, logAs: cmd.replace(/0x[0-9A-F]+$/, "0x****************") });
  } catch (e) {
    if (e.kind === "fail") {
      throw new StepError(
        `The bootloader refused to unlock (${e.remote || "FAILED"}).`,
        "Check the unlock code, and that OEM unlocking is on in the Developer options of Sony's Android. " + NOTHING_CHANGED,
      );
    }
    if (e.kind !== "usb") throw e;
    inst.log("   the phone went away during the unlock; it may be restarting");
  }
  // In case the bootloader restarts after unlocking, wait for it.
  if (await inst.conn.waitForDisconnect(5000)) {
    await inst.conn.release();
    await inst.waitForMode("bootloader");
  }
  const after = await readBootloader(inst);
  if (after.locked) {
    throw new StepError("The bootloader still reports itself as locked.", "Switch the phone off, start it in fastboot mode again and start over.");
  }
  ctx.first.locked = false;
  inst.log("   the bootloader is unlocked");
}

// Step: Sailfish OS and LineageOS run from slot a. If Sony's Android ran from slot b, slot a
// holds the firmware of an earlier update: check it there.
export async function checkSlotA(inst, ctx) {
  if (ctx.stockSlot === "a") {
    inst.log("   the phone runs from slot a, whose firmware the first step checked");
    return;
  }
  await inst.device("bootloader").command("set_active:a");
  await inst.rebootTo("bootloader");
  const info = await readBootloader(inst);
  inst.log(`   slot a: firmware ${info.baseband}, bootloader ${info.bootloader}; slot b: ${ctx.first.baseband}, ${ctx.first.bootloader}`);
  if (info.slot !== "a") throw new StepError("The phone did not switch to slot a.", "Start again from the bootloader.");
  if (!firmwareAtLeast(info.baseband, inst.profile.stock.minFirmware)) {
    await inst.device("bootloader").command(`set_active:${ctx.stockSlot}`);
    throw new StepError(
      `Slot a holds Sony's firmware ${info.baseband || "(unknown)"}, older than the ${inst.profile.stock.minFirmware.join(".")} that LineageOS needs.`,
      `The phone ran from slot ${ctx.stockSlot}, and slot a still holds the firmware of an earlier update. The newer ` +
        "firmware would have to be copied to slot a first (LineageOS's install instructions do this with their " +
        "“copy partitions” step), which this page cannot do yet. Slot " +
        `${ctx.stockSlot} is active again, so the phone starts as before.`,
    );
  }
}

// Step: from the bootloader into LineageOS's fastbootd (slot a's recovery, just written).
// A system update of Sony's Android that was not finished is cancelled: it is replaced.
export async function enterFastbootd(inst) {
  await inst.rebootTo("fastboot", {
    slowAdvice:
      "If the phone shows Sony's recovery or starts Android instead of fastbootd, the LineageOS recovery did not " +
      "start. Switch the phone off, start it in fastboot mode and start over.",
  });
  const fb = inst.device("fastbootd");
  const get = async (name) => {
    const v = await fb.tryGetVar(name);
    inst.log(`   ${name}: ${v === null ? "(not supported)" : v}`);
    return v;
  };
  if ((await get("is-userspace")) !== "yes") throw new StepError("The phone is not in fastbootd.");
  if ((await get("current-slot")) !== "a") throw new StepError("fastbootd does not run from slot a.", "Start again from the bootloader.");
  if ((await get("snapshot-update-status")) !== "none") {
    await fb.command("snapshot-update:cancel");
    const s = await get("snapshot-update-status");
    if (s !== "none") throw new StepError(`An update of Sony's Android cannot be cancelled (status ${s}).`);
  }
  const want = inst.profile.stock.superLayout.deviceSize;
  const size = await get("partition-size:super");
  if (!size || parseInt(size.replace(/^0x/i, ""), 16) !== want) {
    throw new StepError(`The super partition has the size ${size}, not the ${formatSize(want)} this page expects.`);
  }
}

// Step: the build's empty table for super; every partition of Sony's Android in it is gone.
export async function replaceSuper(inst, pkg) {
  await inst.updateSuper(superTable(pkg, inst.profile));
  const fb = inst.device("fastbootd");
  for (const name of inst.profile.stock.logical) {
    if ((await fb.tryGetVar(`is-logical:${name}_a`)) !== "yes") {
      throw new StepError(`After replacing the table of super, ${name}_a is missing.`);
    }
  }
}
