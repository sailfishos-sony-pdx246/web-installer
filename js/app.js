// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// The installer page: choosing the action and the files, checking them, connecting the
// phone, and running the steps with progress, reconnect prompts and error advice.

import { ZipFile } from "./zip.js";
import { Sha256 } from "./sha256.js";
import { Crc32 } from "./crc32.js";
import { formatSize } from "./bytes.js";
import { parseFlashConfig, planFlashOps } from "./flash-config.js";
import { Connection, MODE_LABELS } from "./connection.js";
import { Installer, StepError, zipImage, fileImage, describeOp } from "./steps.js";
import { pdx246 as profile, preflight } from "./device-pdx246.js";
import { Cues, store } from "./cues.js";
import * as stock from "./stock.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MOCK = params.has("mock");
// ?readonly=1: connect and read the phone's variables only; the fastboot layer refuses
// every other command.
const READONLY = params.has("readonly");
// Download tuning for measurements: ?xfer=<bytes per USB transfer>&inflight=<transfers>.
const TUNING = {
  transferSize: Number(params.get("xfer")) || undefined,
  inFlight: Number(params.get("inflight")) || undefined,
};

const cues = new Cues();

const LINEAGE_NEEDS = {
  stock: [],
  install: [],
  again: ["boot.img", "vendor_boot.img", "dtbo.img"],
  back: ["boot.img", "vendor_boot.img", "dtbo.img", "recovery.img", "vendor_dlkm.img"],
};

const INSTALL_INTRO = {
  stock:
    "This takes about half an hour. Do not unplug the phone or close this page. The phone restarts four to five " +
    "times; the first time it restarts into fastbootd, the browser asks you to choose the phone again.",
  default:
    "This takes about ten minutes. Do not unplug the phone or close this page. The phone restarts twice during " +
    "the installation; the first time it restarts into fastbootd, the browser asks you to choose the phone again.",
};

const SCREENS = {
  bootloader: "a dark screen with a small mark in its top left corner (fastboot mode)",
  fastbootd: "the fastbootd screen of the LineageOS recovery",
};

const state = {
  action: "install",
  sailfish: null, // { file, zip, config, plan, images, release }
  sailfishOverride: false,
  lineage: new Map(), // name -> { file, image, known }
  lineageOverride: false,
  lineageZip: null, // { file, pkg, release, sha256 }
  lineageZipOverride: false,
  unlockCode: "",
  unlockAck: false,
  busy: false,
  running: false,
};

let usb = navigator.usb || null;
let mock = null;
let conn = null;

// ---------------------------------------------------------------- log

function log(line) {
  const t = new Date().toTimeString().slice(0, 8);
  const el = $("log");
  el.textContent += `${t} ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(id, kind, html) {
  const el = $(id);
  el.className = `status ${kind || ""}`;
  el.innerHTML = html;
  el.hidden = !html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------- environment

function checkBrowser() {
  const problems = [];
  if (!usb) problems.push("This browser cannot use USB devices (WebUSB). Use Chrome, Chromium, Edge or Brave.");
  else if (!window.isSecureContext) problems.push("WebUSB needs a page opened over https.");
  if (typeof DecompressionStream === "undefined") problems.push("This browser is too old: it cannot unpack zip files.");
  if (problems.length) {
    setStatus("browser-check", "bad", problems.map(escapeHtml).join("<br>"));
    return false;
  }
  setStatus("browser-check", "good", MOCK ? "Simulation: a simulated phone stands in for USB." : "This browser can talk to the phone over USB.");
  return true;
}

// ---------------------------------------------------------------- action

function onActionChange() {
  state.action = document.querySelector('input[name="action"]:checked').value;
  $("zip-field").hidden = state.action === "back";
  const needs = LINEAGE_NEEDS[state.action];
  $("lineage-field").hidden = needs.length === 0;
  $("lineage-needs").textContent = needs.join(", ");
  $("lineage-zip-field").hidden = state.action !== "stock";
  $("unlock-field").hidden = state.action !== "stock";
  $("install-intro").textContent = INSTALL_INTRO[state.action] || INSTALL_INTRO.default;
  renderLineage();
  if (conn && conn.connected) identify();
  updateReady();
}

// ---------------------------------------------------------------- Sailfish OS zip

async function hashFile(file, onProgress) {
  const sha = new Sha256();
  const reader = file.stream().getReader();
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    sha.update(value);
    done += value.length;
    onProgress(done, file.size);
  }
  return sha.hex();
}

async function checkZipEntry(zip, entry, onBytes) {
  const crc = new Crc32();
  const reader = (await zip.stream(entry)).getReader();
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    crc.update(value);
    size += value.length;
    onBytes(value.length);
  }
  if (size !== entry.size || crc.digest() !== entry.crc32) {
    throw new Error(`${entry.name.split("/").pop()} in the zip is damaged.`);
  }
}

async function onZipChosen(file) {
  state.sailfish = null;
  state.sailfishOverride = false;
  $("zip-override").hidden = true;
  $("zip-override-box").checked = false;
  updateReady();
  if (!file) {
    setStatus("zip-status", "", "");
    return;
  }
  state.busy = true;
  updateReady();
  try {
    setStatus("zip-status", "work", "Reading the zip…");
    const zip = await ZipFile.open(file);
    const files = zip.imageFiles();
    const cfg = files.get("flash-config.sh");
    if (!cfg) throw new Error("This zip has no flash-config.sh: it is not a Sailfish OS image zip.");
    const config = parseFlashConfig(await zip.text(cfg));
    const images = new Map();
    for (const [name, entry] of files) images.set(name, zipImage(zip, entry, name));
    const plan = planFlashOps(config, profile, images);
    if (!config.products.length) plan.problems.push("VALID_PRODUCTS is empty");
    if (plan.problems.length) {
      throw new Error(`This page cannot install this image:\n${plan.problems.join("\n")}`);
    }
    if (!config.products.some((p) => profile.products.includes(p))) {
      throw new Error(`This image is for ${config.products.join(", ")}, not for the ${profile.name}.`);
    }

    const sha = await hashFile(file, (d, t) =>
      setStatus("zip-status", "work", `Checking the zip (1 of 2): checksum, ${Math.floor((100 * d) / t)} %`),
    );
    const release = profile.releases.find((r) => r.sha256 === sha) || null;

    const written = [...new Set(plan.ops.filter((o) => o.kind === "flash").map((o) => o.file))];
    const entries = written.map((name) => files.get(name));
    const total = entries.reduce((s, e) => s + e.size, 0);
    let done = 0;
    for (const entry of entries) {
      await checkZipEntry(zip, entry, (n) => {
        done += n;
        setStatus("zip-status", "work", `Checking the zip (2 of 2): images, ${Math.floor((100 * done) / total)} %`);
      });
    }

    state.sailfish = { file, zip, config, plan, images, release, sha };
    if (release) {
      setStatus(
        "zip-status",
        "good",
        `Sailfish OS release <strong>${escapeHtml(release.tag)}</strong>: the checksum matches the published one, and its images are intact.`,
      );
    } else {
      setStatus(
        "zip-status",
        "warn",
        `This zip is not one of the published releases this page knows (SHA-256 <code>${sha.slice(0, 16)}…</code>). Its images are intact.`,
      );
      $("zip-override").hidden = false;
    }
    log(`zip: ${file.name}, ${formatSize(file.size)}, sha256 ${sha}${release ? ` (release ${release.tag})` : " (unknown)"}`);
    log(`zip: VALID_PRODUCTS ${config.products.join(" ")}; ${plan.ops.length} operations`);
  } catch (e) {
    setStatus("zip-status", "bad", escapeHtml(e.message).replace(/\n/g, "<br>"));
    log(`zip: ${e.message.replace(/\n/g, "; ")}`);
  } finally {
    state.busy = false;
    updateReady();
  }
}

// ---------------------------------------------------------------- LineageOS images

async function onLineageChosen(files) {
  state.lineageOverride = false;
  $("lineage-override-box").checked = false;
  state.busy = true;
  updateReady();
  try {
    for (const file of files) {
      const expected = profile.lineage.images[file.name];
      if (!expected) {
        log(`lineage: ignoring ${file.name} (not one of the images this page uses)`);
        continue;
      }
      state.lineage.set(file.name, { file, image: fileImage(file), known: null });
      renderLineage();
      const sha = await hashFile(file, () => {});
      const known = sha === expected.sha256 && file.size === expected.size;
      state.lineage.get(file.name).known = known;
      log(`lineage: ${file.name}, ${formatSize(file.size)}, sha256 ${sha}${known ? "" : " (differs from the release)"}`);
      renderLineage();
    }
  } finally {
    state.busy = false;
    updateReady();
  }
}

function renderLineage() {
  const needs = LINEAGE_NEEDS[state.action];
  const ul = $("lineage-status");
  ul.innerHTML = "";
  let unknown = false;
  for (const name of needs) {
    const li = document.createElement("li");
    const item = state.lineage.get(name);
    if (!item) {
      li.className = "missing";
      li.textContent = `${name}: not chosen yet`;
    } else if (item.known === null) {
      li.className = "work";
      li.textContent = `${name}: checking…`;
    } else if (item.known) {
      li.className = "good";
      li.textContent = `${name}: matches LineageOS ${profile.lineage.tag}`;
    } else {
      li.className = "warn";
      li.textContent = `${name}: differs from LineageOS ${profile.lineage.tag}`;
      unknown = true;
    }
    ul.appendChild(li);
  }
  $("lineage-override").hidden = !unknown;
}

function lineageReady() {
  const needs = LINEAGE_NEEDS[state.action];
  for (const name of needs) {
    const item = state.lineage.get(name);
    if (!item || item.known === null) return false;
    if (!item.known && !state.lineageOverride) return false;
  }
  return true;
}

function sailfishReady() {
  if (state.action === "back") return true;
  const s = state.sailfish;
  return !!s && (!!s.release || state.sailfishOverride);
}

// ---------------------------------------------------------------- LineageOS zip (from Sony's Android)

async function onLineageZipChosen(file) {
  state.lineageZip = null;
  state.lineageZipOverride = false;
  $("lineage-zip-override").hidden = true;
  $("lineage-zip-override-box").checked = false;
  if (!file) {
    setStatus("lineage-zip-status", "", "");
    updateReady();
    return;
  }
  state.busy = true;
  updateReady();
  const t0 = performance.now();
  try {
    const r = await stock.checkLineageZip(file, profile, (text) => setStatus("lineage-zip-status", "work", escapeHtml(text)));
    state.lineageZip = { file, ...r };
    const secs = Math.round((performance.now() - t0) / 1000);
    log(`lineage zip: ${file.name}, ${formatSize(file.size)}, sha256 ${r.sha256}${r.release ? ` (release ${r.release.tag})` : " (unknown)"}`);
    log(`lineage zip: all ${r.pkg.partitions.size} partitions unpack to their checksums (${secs} s)`);
    if (r.release) {
      setStatus(
        "lineage-zip-status",
        "good",
        `LineageOS release <strong>${escapeHtml(r.release.tag)}</strong>: the checksum matches the published one, and every partition in it unpacks correctly.`,
      );
    } else {
      setStatus(
        "lineage-zip-status",
        "warn",
        `This zip is not the LineageOS release this page knows (SHA-256 <code>${r.sha256.slice(0, 16)}…</code>), though every partition in it unpacks correctly. Sailfish OS is built for ${escapeHtml(profile.lineage.tag)}.`,
      );
      $("lineage-zip-override").hidden = false;
    }
  } catch (e) {
    setStatus("lineage-zip-status", "bad", escapeHtml(e.message));
    log(`lineage zip: ${e.message}`);
  } finally {
    state.busy = false;
    updateReady();
  }
}

function lineageZipReady() {
  if (state.action !== "stock") return true;
  const z = state.lineageZip;
  return !!z && (!!z.release || state.lineageZipOverride);
}

// The unlock code is needed only if the connected phone's bootloader is locked.
function onUnlockInput() {
  const code = stock.normalizeUnlockCode($("unlock-input").value);
  state.unlockCode = profile.stock.unlockCode.test(code) ? code : "";
  if (!code) setStatus("unlock-status", "", "");
  else if (state.unlockCode) setStatus("unlock-status", "good", "The code has the right form.");
  else setStatus("unlock-status", "warn", "Sony's code has 16 characters, digits and the letters A to F.");
  state.unlockAck = $("unlock-ack-box").checked;
  updateReady();
}

function unlockReady() {
  if (state.action !== "stock" || !conn || conn.locked !== true) return true;
  return !!state.unlockCode && state.unlockAck;
}

// ---------------------------------------------------------------- connecting

function describeConnection() {
  if (!conn.connected) {
    setStatus("connect-status", "", "");
    return;
  }
  if (conn.mode === "bootloader") {
    setStatus("connect-status", "good", `Connected: the phone is in ${MODE_LABELS.bootloader}.${conn.info ? ` ${escapeHtml(conn.info)}` : ""}`);
  } else {
    setStatus(
      "connect-status",
      "warn",
      `The phone is in ${MODE_LABELS[conn.mode]}. The installation starts from the bootloader: on the phone, choose <em>Reboot to bootloader</em>, then click Connect again.`,
    );
  }
}

async function identify() {
  if (conn.mode !== "bootloader" || identifying) return;
  identifying = true;
  try {
    const fb = conn.fb;
    const product = await fb.tryGetVar("product");
    const baseband = await fb.tryGetVar("version-baseband");
    const bootloader = await fb.tryGetVar("version-bootloader");
    const secure = await fb.tryGetVar("secure");
    const unlocked = await fb.tryGetVar("unlocked");
    log(`found ${product}, baseband ${baseband}, bootloader ${bootloader}, secure ${secure}, unlocked ${unlocked}`);
    conn.locked = unlocked === "no" || (unlocked === null && secure === "yes");
    let info = profile.products.includes(product)
      ? `Model ${product} (${profile.name}).`
      : `It reports itself as “${product}”, which is not an ${profile.name}.`;
    if (state.action === "stock") {
      // getvar:all also gives the active slot (its lines are not logged: they hold the serial number).
      const all = await fb.getVarAll();
      const slot = (all.get("current-slot") || "").replace(/^_/, "");
      log(`active slot ${slot || "unknown"}`);
      info += ` Firmware ${baseband}, slot ${slot || "?"} active.`;
      if (!stock.firmwareAtLeast(baseband, profile.stock.minFirmware)) {
        info += ` LineageOS needs firmware ${profile.stock.minFirmware.join(".")} or newer: install Sony's updates first.`;
      }
      info += conn.locked
        ? " The bootloader is locked: enter Sony's unlock code in step 2."
        : " The bootloader is unlocked.";
      if (conn.locked && slot === "b") {
        info +=
          " Sony's Android runs from slot b, so whether slot a holds firmware new enough can only be checked after " +
          "unlocking. If it does not, this page cannot install yet.";
      }
    } else if (conn.locked) {
      info += " Its bootloader is locked.";
    }
    conn.info = info;
  } catch (e) {
    conn.info = `Could not read the model: ${e.message}`;
  } finally {
    identifying = false;
  }
  describeConnection();
  updateReady();
}
let identifying = false;

function connectAdvice(e) {
  if (e.name === "NotFoundError") return "No phone was chosen. Is it in fastboot mode and plugged in?";
  if (e.kind === "access") {
    return (
      "The browser may not open the phone. On Linux, this needs a udev rule (see “Your computer” above); " +
      "on Windows, a driver for fastboot mode."
    );
  }
  if (e.kind === "busy") return e.message + " Close other programs that use it and try again.";
  return e.message;
}

// ---------------------------------------------------------------- read-only check

const hex4 = (n) => n.toString(16).padStart(4, "0");

async function runReadOnlyCheck() {
  const fb = conn.fb;
  const dev = fb.usb;
  const rows = [
    ["USB device", `${hex4(dev.vendorId)}:${hex4(dev.productId)} ${dev.manufacturerName || ""} ${dev.productName || ""}`.trim()],
    ["Mode", MODE_LABELS[conn.mode]],
    ["Fastboot interface", `interface ${fb.iface}, bulk in ${fb.epIn} (${fb.packetSizeIn} bytes), out ${fb.epOut} (${fb.packetSizeOut} bytes)`],
  ];
  // The bootloader gets exactly flash.sh's questions, which it is known to answer well.
  const names =
    conn.mode === "fastbootd"
      ? ["product", "is-userspace", "current-slot", "snapshot-update-status", "is-logical:vendor_dlkm_a", "max-download-size"]
      : ["product", "version-baseband", "version-bootloader", "secure"];
  const values = {};
  let failed = null;
  for (const name of names) {
    const t0 = performance.now();
    try {
      const v = await fb.tryGetVar(name);
      values[name] = v;
      rows.push([`getvar ${name}`, v === null ? "(not supported)" : v, `${Math.round(performance.now() - t0)} ms`]);
    } catch (e) {
      failed = e;
      rows.push([`getvar ${name}`, `error: ${e.message}`, ""]);
      break;
    }
  }

  const table = $("readonly-results");
  table.innerHTML = "";
  for (const [k, v, t] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = v;
    const tt = document.createElement("td");
    tt.className = "time";
    tt.textContent = t || "";
    tr.append(th, td, tt);
    table.appendChild(tr);
    log(`check: ${k}: ${v}${t ? ` (${t})` : ""}`);
  }
  table.hidden = false;

  let verdict;
  let kind;
  if (failed) {
    kind = "bad";
    verdict = `The phone stopped answering: ${failed.message}`;
  } else if (!profile.products.includes(values.product)) {
    kind = "warn";
    verdict = `The browser can talk to the phone, but it reports itself as “${values.product}”, not as an ${profile.name}.`;
  } else if (conn.mode === "bootloader" && values.secure === "yes") {
    kind = "warn";
    verdict = "The browser can talk to the phone, but its bootloader reports secure=yes: it looks locked.";
  } else {
    kind = "good";
    verdict = `Read-only check passed: the browser can talk to the ${profile.name} in ${MODE_LABELS[conn.mode]}.`;
  }
  setStatus("readonly-verdict", kind, escapeHtml(verdict));
  log(`check: ${verdict}`);

  // Let go of the phone, so that fastboot on this computer can reach it again.
  await conn.release();
  log("check: the page released the phone");

  if (params.has("upload")) {
    try {
      await fetch(`/upload/readonly-check-${Date.now()}.log`, { method: "PUT", body: $("log").textContent });
    } catch {
      // only with tools/dev_server.py --upload-dir
    }
  }
}

function onConnectClick() {
  // requestDevice() has to run inside the click handler, before any await.
  const pending = conn.choose();
  pending
    .then(() => (READONLY ? runReadOnlyCheck() : identify()))
    .catch((e) => {
      setStatus("connect-status", "bad", escapeHtml(connectAdvice(e)));
      log(`connect: ${e.message}`);
    })
    .finally(updateReady);
}

// ---------------------------------------------------------------- waiting for the phone

let waitTimer = null;
let cueTimers = [];
let cueShowing = false;

function clearCue() {
  for (const t of cueTimers) clearTimeout(t);
  cueTimers = [];
  if (cueShowing) cues.title(null);
  cueShowing = false;
}

// The browser lets the page reopen only USB identities it was allowed before. For a new one
// (fastbootd, the first time in this browser) the user has to click: the page asks for that
// at once, with a chime, a flashing title and the focus on Connect. For a known one it waits
// a minute before asking, in case the permission was withdrawn.
function cueConnect(mode) {
  const identity = profile.identityOf(mode);
  const known = identity && store.get(`allowed:${identity}`) === "1";
  const ask = () => {
    cueShowing = true;
    cues.title("▶ Connect the phone – Sailfish OS Installer");
    $("wait-connect").focus({ preventScroll: true });
    $("wait-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    cues.chime("attention");
    cueTimers.push(setTimeout(() => cues.chime("attention"), 30000));
  };
  cueTimers.push(setTimeout(ask, known ? 60000 : 1000));
  return known;
}

function onWaiting(info) {
  clearInterval(waitTimer);
  clearCue();
  if (!info) {
    $("wait-panel").hidden = true;
    return;
  }
  $("wait-panel").hidden = false;
  const known = cueConnect(info.mode);
  $("wait-text").innerHTML =
    `The phone is restarting into <strong>${MODE_LABELS[info.mode]}</strong>. ` +
    (known
      ? "This browser has connected it in this mode before, so the installation should continue by itself. " +
        `If it does not, click <em>Connect</em> when the phone shows ${SCREENS[info.mode]}.`
      : `Click <em>Connect</em> and choose the phone: it appears in the list when it shows ${SCREENS[info.mode]}. ` +
        "The browser asks this once; next time the page finds the phone by itself.");
  $("wait-slow").hidden = true;
  $("wait-stop").hidden = true;
  $("wait-error").hidden = true;
  waitTimer = setInterval(() => {
    const s = Math.floor((Date.now() - info.since) / 1000);
    $("wait-time").textContent = `Waiting for ${s} s.`;
    if (s >= 90) {
      $("wait-slow").hidden = false;
      $("wait-slow").textContent =
        info.slowAdvice ||
        "This takes unusually long. Check the phone's screen; if it does not show the mode above, stop and start over.";
      $("wait-stop").hidden = false;
    }
  }, 1000);
}

function onWaitConnectClick() {
  const pending = conn.choose();
  pending.catch((e) => {
    $("wait-error").hidden = false;
    $("wait-error").textContent = connectAdvice(e);
  });
}

// ---------------------------------------------------------------- the installation

// From Sony's Android: the phone's checks and the unlock, LineageOS from its zip to slot a
// (boot images in the bootloader, the dynamic partitions in its fastbootd), then the steps of
// the Sailfish OS zip as for a phone with LineageOS.
function stockSteps() {
  const steps = [];
  const ctx = { unlockCode: state.unlockCode };
  const pkg = state.lineageZip.pkg;
  steps.push({ title: "Check the phone and its firmware", run: (inst) => stock.checkStockPhone(inst, ctx) });
  steps.push({ title: "Unlock the bootloader (if it is locked)", run: (inst) => stock.unlockBootloader(inst, ctx) });
  steps.push({ title: "Check the firmware of slot a", run: (inst) => stock.checkSlotA(inst, ctx) });
  for (const [src, dst] of profile.stock.physical) {
    const p = pkg.partition(src);
    steps.push({
      title: `Write ${dst} (LineageOS ${src}, ${formatSize(p.size)})`,
      lineageWrite: true,
      run: (inst) => inst.flash(dst, p.image(`LineageOS ${src}`)),
    });
  }
  steps.push({ title: "Make slot a active", run: (inst) => inst.device().command("set_active:a") });
  steps.push({ title: "Restart into LineageOS's fastbootd and check the phone", run: (inst) => stock.enterFastbootd(inst) });
  steps.push({ title: "Replace the partition table of super", run: (inst) => stock.replaceSuper(inst, pkg) });
  const group = pkg.manifest.dynamic.groups.find((g) => g.name === profile.stock.group);
  for (const name of group.partitions) {
    const p = pkg.partition(name);
    steps.push({
      title: `Write ${name}_a (LineageOS ${name}, ${formatSize(p.size)})`,
      run: (inst) => inst.flash(`${name}_a`, p.image(`LineageOS ${name}`)),
    });
  }
  steps.push({ title: "Restart into the bootloader", run: (inst) => inst.rebootTo("bootloader") });
  const { config, plan, images } = state.sailfish;
  steps.push({ title: "Check the phone for Sailfish OS", run: (inst) => inst.checkPhone(config.products, plan.checks) });
  for (const op of plan.ops) {
    steps.push({
      title: describeOp(op, images, profile),
      sailfishBoot: op.kind === "flash" && op.partition === "boot_a",
      run: (inst) => inst.runOp(op, images),
    });
  }
  return steps;
}

function buildSteps() {
  if (state.action === "stock") return stockSteps();
  const steps = [];
  const action = state.action;
  const lineage = (name) => state.lineage.get(name).image;
  let products;
  let checks;
  if (action === "back") {
    products = profile.products;
    checks = [profile.lockedCheck];
  } else {
    products = state.sailfish.config.products;
    checks = state.sailfish.plan.checks;
  }
  steps.push({ title: "Check the phone", run: (inst) => inst.checkPhone(products, checks) });

  if (action === "again" || action === "back") {
    const parts = [
      ["boot_a", "boot.img"],
      ["vendor_boot_a", "vendor_boot.img"],
      ["dtbo_a", "dtbo.img"],
    ];
    if (action === "back") parts.push(["recovery_a", "recovery.img"]);
    for (const [partition, name] of parts) {
      steps.push({
        title: `Write ${partition} (LineageOS ${name})`,
        sailfishBoot: false,
        run: (inst) => inst.flash(partition, lineage(name)),
      });
    }
  }

  if (action === "back") {
    steps.push({ title: "Make slot a active", run: (inst) => inst.device().command("set_active:a") });
    steps.push({ title: preflight.title, run: (inst) => preflight(inst, ["--reboot-fastboot"]) });
    steps.push({
      title: "Write vendor_dlkm_a (LineageOS vendor_dlkm.img)",
      run: (inst) => inst.flash("vendor_dlkm_a", lineage("vendor_dlkm.img")),
    });
    return steps;
  }

  const { plan, images } = state.sailfish;
  for (const op of plan.ops) {
    steps.push({
      title: describeOp(op, images, profile),
      sailfishBoot: op.kind === "flash" && op.partition === "boot_a",
      run: (inst) => inst.runOp(op, images),
    });
  }
  return steps;
}

function renderSteps(steps) {
  const ol = $("step-list");
  ol.innerHTML = "";
  for (const s of steps) {
    const li = document.createElement("li");
    li.textContent = s.title;
    li.className = "pending";
    s.el = li;
    ol.appendChild(li);
  }
}

function failureAdvice(e, steps, index) {
  const wroteSailfishBoot = steps.slice(0, index + 1).some((s) => s.sailfishBoot && s.el.className !== "pending");
  const lines = [];
  if (e.advice) lines.push(e.advice);
  if (state.action === "stock") {
    // Every run of this flow writes LineageOS's boot images first, so it can always start over.
    const wroteSomething = steps.slice(0, index + 1).some((s) => s.lineageWrite && s.el.className !== "pending");
    if (e.kind === "usb" || e.kind === "timeout") lines.push("The USB connection to the phone was lost.");
    if (e.kind === "access") lines.push(connectAdvice(e));
    if (wroteSomething) {
      lines.push(
        "Sony's Android is partly replaced now. Switch the phone off, start it in fastboot mode again (hold volume up " +
          "while plugging in), click Connect and start this installation again: it writes everything once more.",
      );
    }
    if (!lines.length) lines.push("Start the phone in fastboot mode again, click Connect and start again.");
    return lines;
  }
  if (e.kind === "usb" || e.kind === "timeout") {
    lines.push(
      "The USB connection to the phone was lost. Unplug it, start it in fastboot mode again " +
        "(power off, hold volume up while plugging in), click Connect and start again. " +
        "Partitions that were only partly written are written again from the start.",
    );
  }
  if (e.kind === "access") lines.push(connectAdvice(e));
  if (wroteSailfishBoot && state.action !== "back") {
    lines.push(
      "The Sailfish OS boot image was already written, so fastbootd can no longer be reached: " +
        "choose “Install again” and add the LineageOS images.",
    );
  }
  if (!lines.length) lines.push("Start the phone in fastboot mode again, click Connect and start again.");
  return lines;
}

async function onStartClick() {
  cues.prepare(); // inside the click: the page may play sounds later
  cues.title(null);
  const warning =
    state.action === "back"
      ? "Going back to LineageOS replaces Sailfish OS. Its data is lost: you format the data afterwards. Continue?"
      : state.action === "stock"
        ? "This replaces Sony's Android with LineageOS 23.2 and Sailfish OS and erases all data on the phone." +
          (conn.locked ? " Unlocking the bootloader removes Sony's DRM keys for good and ends Sony's updates." : "") +
          " Continue?"
        : "Installing Sailfish OS erases all data on the phone. Continue?";
  if (!window.confirm(warning)) return;

  const steps = buildSteps();
  renderSteps(steps);
  $("error-panel").hidden = true;
  $("step-done").hidden = true;
  state.running = true;
  updateReady();

  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // not available; the computer may sleep during a long transfer
  }

  const inst = new Installer({ conn, profile, log, onWaiting, timeScale: 1 });
  let failed = false;
  log(`== ${state.action}: ${steps.length} steps`);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    step.el.className = "running";
    $("progress").value = 0;
    $("progress-text").textContent = "";
    inst.progress = (done, total) => {
      $("progress").value = total ? done / total : 0;
      $("progress-text").textContent = `${formatSize(done)} of ${formatSize(total)}`;
    };
    log(`-- step ${i + 1}: ${step.title}`);
    try {
      await step.run(inst);
      step.el.className = "done";
    } catch (e) {
      step.el.className = "failed";
      failed = true;
      log(`!! ${e.message}`);
      $("error-title").textContent = e.message;
      const advice = $("error-advice");
      advice.innerHTML = "";
      for (const line of failureAdvice(e, steps, i)) {
        const p = document.createElement("p");
        p.textContent = line;
        advice.appendChild(p);
      }
      $("error-panel").hidden = false;
      onWaiting(null);
      cues.chime("error");
      cues.title("✗ Stopped – Sailfish OS Installer", false);
      $("error-panel").scrollIntoView({ behavior: "smooth", block: "center" });
      break;
    }
  }
  onWaiting(null);
  try {
    await wakeLock?.release();
  } catch {
    // ignore
  }
  state.running = false;
  $("progress-text").textContent = "";
  if (!failed) showDone();
  updateReady();
}

function showDone() {
  log("== done");
  cues.chime("done");
  cues.title("✓ Done – Sailfish OS Installer", false);
  $("step-done").hidden = false;
  if (state.action === "back") {
    $("done-text").textContent =
      "The LineageOS images are written, and the phone shows fastbootd. On the phone, choose Enter recovery, " +
      "then Factory reset, Format data/factory reset, confirm, and then Reboot system now.";
    $("reboot-btn").hidden = true;
    $("first-start").hidden = true;
  } else {
    // flash-config.sh's message is written for the command line.
    const msg = (state.sailfish.config.vars.FLASH_COMPLETED_MESSAGE || "Flashing completed.").trim();
    $("done-text").textContent = msg
      .replace(/\s*\n\s*/g, " ")
      .replace(/,? or run '?fastboot reboot'?/, ", or click “Restart the phone”");
    $("reboot-btn").hidden = !conn.connected;
    $("first-start").hidden = false;
  }
  $("step-done").scrollIntoView({ behavior: "smooth" });
}

async function onRebootClick() {
  try {
    await conn.fb.command("reboot");
    log("the phone restarts");
  } catch (e) {
    log(`reboot: ${e.message}`);
  }
  $("reboot-btn").hidden = true;
}

// ---------------------------------------------------------------- readiness

function updateReady() {
  const filesOk = sailfishReady() && lineageReady() && lineageZipReady();
  const connected = conn && conn.connected && conn.mode === "bootloader";
  const unlockOk = unlockReady();
  $("start-btn").disabled = state.busy || state.running || !filesOk || !connected || !unlockOk;
  $("connect-btn").disabled = state.running || !usb;
  for (const el of document.querySelectorAll(
    'input[name="action"], #zip-input, #lineage-input, #lineage-zip-input, #unlock-input, #unlock-ack-box',
  )) {
    el.disabled = state.running;
  }
  let why = "";
  if (!state.running) {
    if (!filesOk) why = "Choose the files first (step 2).";
    else if (!connected) why = "Connect the phone in fastboot mode first (step 3).";
    else if (!unlockOk) why = "The bootloader is locked: enter Sony's unlock code and confirm (step 2).";
  }
  $("start-why").textContent = why;
}

// ---------------------------------------------------------------- simulation

async function setupMock() {
  const { createMock } = await import("./mock-usb.js");
  // ?mockReset=1: forget the simulated USB permissions and what the page remembers of them,
  // as in a browser that never saw the phone.
  if (params.has("mockReset")) store.removeAll("allowed:");
  mock = createMock({
    bootA: params.get("bootA") || "lineage",
    merge: params.get("merge") || "none",
    lostReply: params.get("lostReply") !== "0",
    scale: Number(params.get("scale") || 0.2),
    latency: Number(params.get("usbLatency") || 0),
    resetPermissions: params.has("mockReset"),
    lineageBootSha256: profile.lineage.images["boot.img"].sha256,
    // A phone with Sony's Android (?stock=1), and how it is set up.
    stock: params.has("stock"),
    stockSlot: params.get("stockSlot") || "b",
    unlocked: params.has("unlocked"),
    fwA: params.get("fwA") || undefined,
    fwB: params.get("fwB") || undefined,
    oemUnlock: params.get("oemUnlock") || "on",
    unlockCode: params.get("unlockCode") || undefined,
    unlockReboots: params.has("unlockReboots"),
    fastbootdMax: Number(params.get("fastbootdMax")) || undefined,
    // SHA-256 of further boot images that count as LineageOS's (a test zip's).
    lineageBoots: (params.get("lineageBoot") || "").split(",").filter(Boolean),
  });
  usb = mock.usb;
  window.__mock = mock;
  $("mock-banner").hidden = false;
  $("mock-fastboot").addEventListener("click", () => {
    mock.phone.enterFastboot();
    log("simulation: the phone was switched off and started in fastboot mode");
  });
  setInterval(() => {
    $("mock-where").textContent = mock.phone.where;
  }, 500);
}

// Test hook (simulation only): read files from the test server instead of the file pickers.
async function loadTestFiles() {
  const { RangeFile } = await import("./mock-files.js");
  const zip = params.get("testzip");
  if (zip) await onZipChosen(await RangeFile.open(zip));
  const lineage = params.get("testlineage");
  if (lineage) {
    const files = [];
    for (const name of Object.keys(profile.lineage.images)) files.push(await RangeFile.open(`${lineage}/${name}`));
    await onLineageChosen(files);
  }
  const lineageZip = params.get("testlineagezip");
  if (lineageZip) await onLineageZipChosen(await RangeFile.open(lineageZip));
}

// ---------------------------------------------------------------- start

async function main() {
  if (MOCK) await setupMock();
  const ok = checkBrowser();
  conn = new Connection(usb || new EventTarget(), profile, log, { readOnly: READONLY, ...TUNING });
  if (TUNING.transferSize || TUNING.inFlight) {
    log(`download tuning: ${TUNING.transferSize || "default"} bytes per transfer, ${TUNING.inFlight || "default"} in flight`);
  }
  // Remember which USB identities this browser has allowed (see cueConnect).
  conn.addEventListener("change", () => {
    if (conn.connected) store.set(`allowed:${hex4(conn.fb.vendorId)}:${hex4(conn.fb.productId)}`, "1");
  });
  $("sound-box").checked = cues.enabled;
  $("sound-box").addEventListener("change", (e) => {
    cues.setEnabled(e.target.checked);
    if (e.target.checked) {
      cues.prepare();
      cues.chime("done");
    }
  });
  if (READONLY) {
    $("readonly-section").hidden = false;
    for (const id of ["sec-action", "sec-files", "sec-install", "step-done"]) $(id).hidden = true;
    document.querySelector("#sec-connect .num").hidden = true;
    log("read-only mode: only getvar commands are sent");
    log(`browser: ${navigator.userAgent}`);
  }
  conn.addEventListener("change", () => {
    describeConnection();
    updateReady();
  });
  window.__conn = conn;
  window.__state = state;
  window.__cues = cues;

  for (const r of document.querySelectorAll('input[name="action"]')) r.addEventListener("change", onActionChange);
  $("zip-input").addEventListener("change", (e) => onZipChosen(e.target.files[0] || null));
  $("lineage-input").addEventListener("change", (e) => onLineageChosen([...e.target.files]));
  $("zip-override-box").addEventListener("change", (e) => {
    state.sailfishOverride = e.target.checked;
    updateReady();
  });
  $("lineage-override-box").addEventListener("change", (e) => {
    state.lineageOverride = e.target.checked;
    updateReady();
  });
  $("lineage-zip-input").addEventListener("change", (e) => onLineageZipChosen(e.target.files[0] || null));
  $("lineage-zip-override-box").addEventListener("change", (e) => {
    state.lineageZipOverride = e.target.checked;
    updateReady();
  });
  $("unlock-input").addEventListener("input", onUnlockInput);
  $("unlock-ack-box").addEventListener("change", onUnlockInput);
  $("connect-btn").addEventListener("click", onConnectClick);
  $("wait-connect").addEventListener("click", onWaitConnectClick);
  $("wait-stop").addEventListener("click", () =>
    conn.cancelWait(new StepError("Stopped while waiting for the phone.", $("wait-slow").textContent)),
  );
  $("start-btn").addEventListener("click", onStartClick);
  $("reboot-btn").addEventListener("click", onRebootClick);
  $("copy-log").addEventListener("click", () => navigator.clipboard?.writeText($("log").textContent));
  window.addEventListener("beforeunload", (e) => {
    if (state.running) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Test instrumentation (tools/dev_server.py --upload-dir): with ?upload=1 the log goes to
  // the server every few seconds, so a run on a real phone can be followed from the computer.
  if (params.has("upload") && !READONLY) {
    const name = `install-${Date.now()}.log`;
    let sent = "";
    setInterval(() => {
      const text = $("log").textContent;
      if (text === sent) return;
      sent = text;
      fetch(`/upload/${name}`, { method: "PUT", body: text }).catch(() => {});
    }, 3000);
  }

  onActionChange();
  if (!ok) $("connect-btn").disabled = true;
  if (MOCK) await loadTestFiles();
}

main().catch((e) => {
  log(`page error: ${e.message}`);
  console.error(e);
});
