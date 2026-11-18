// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// A simulated Xperia 10 VI for testing the page without a phone (index.html?mock=1).
// It stands in for navigator.usb: the phone appears as a fastboot device with the USB
// identities of the real bootloader and fastbootd, answers like them (including the Sony
// bootloader's FAIL for long getvar names and the lost answer to reboot-fastboot), and
// records what is written. For sparse images it computes the same content digest as
// tools/sparse_digest.py, so a test can compare the result with the image files.
//
// With `stock`, it is a phone with Sony's Android as sold: a locked bootloader that refuses
// to write or switch slots until Sony's unlock command, Sony's partitions in super, Sony's
// recovery (no fastbootd), and the active slot and each slot's firmware as given. What the
// real bootloader does there is partly assumed (see the README).

import { BlockDigest, parseSparseHeader, CHUNK_RAW, CHUNK_FILL } from "./sparse.js";
import { Sha256 } from "./sha256.js";
import { concatBytes, sleep } from "./bytes.js";
import { parseSuperImage } from "./lp-metadata.js";

const MiB = 1024 * 1024;

const IDENTITIES = {
  // The Sony bootloader's USB strings, as read on a real phone (2026-11-17).
  bootloader: { vendorId: 0x0fce, productId: 0x0dde, manufacturerName: "Google", productName: "Android" },
  fastbootd: { vendorId: 0x18d1, productId: 0x4ee0, manufacturerName: "Sony", productName: "XQ-ES54" },
};

const PHYSICAL = [
  "boot_a", "boot_b", "vendor_boot_a", "vendor_boot_b", "dtbo_a", "dtbo_b", "recovery_a", "recovery_b",
  "vbmeta_a", "vbmeta_b", "vbmeta_system_a", "vbmeta_system_b", "userdata", "super", "metadata", "misc",
];

function domError(name, message) {
  return new DOMException(message, name);
}

function packet(text) {
  const b = new TextEncoder().encode(text);
  return { status: "ok", data: new DataView(b.buffer) };
}

class MockDevice {
  constructor(phone, mode) {
    Object.assign(this, IDENTITIES[mode]);
    this.mode = mode;
    this.phone = phone;
    this.serialNumber = "MOCK00000001";
    this.opened = false;
    this.gone = false;
    this.configuration = null;
    this.configurations = [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 0xff,
                interfaceSubclass: 0x42,
                interfaceProtocol: 0x03,
                endpoints: [
                  { endpointNumber: 1, direction: "in", type: "bulk", packetSize: 512 },
                  { endpointNumber: 1, direction: "out", type: "bulk", packetSize: 512 },
                ],
              },
            ],
          },
        ],
      },
    ];
    this.answers = [];
    this.readers = [];
  }

  alive() {
    if (this.gone) throw domError("NotFoundError", "The device was disconnected.");
  }

  async open() {
    this.alive();
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  async selectConfiguration() {
    this.alive();
    this.configuration = this.configurations[0];
  }

  async claimInterface() {
    this.alive();
  }

  async releaseInterface() {}

  async selectAlternateInterface() {}

  async transferOut(endpoint, data) {
    this.alive();
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    // A round trip per transfer, like USB through a browser and a VM (?usbLatency=ms).
    if (this.phone.latency) {
      await sleep(this.phone.latency);
      this.alive();
    }
    await this.phone.receive(this, u8);
    return { status: "ok", bytesWritten: u8.byteLength };
  }

  transferIn() {
    if (this.gone) return Promise.reject(domError("NotFoundError", "The device was disconnected."));
    if (this.answers.length) return Promise.resolve(packet(this.answers.shift()));
    return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
  }

  answer(text) {
    if (this.gone) return;
    const r = this.readers.shift();
    if (r) r.resolve(packet(text));
    else this.answers.push(text);
  }

  unplug() {
    this.gone = true;
    for (const r of this.readers) r.reject(domError("NotFoundError", "The device was disconnected."));
    this.readers = [];
  }
}

function firstDataBlock(data) {
  const h = parseSparseHeader(data);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = h.fileHeaderSize;
  let pos = 0;
  for (let i = 0; i < h.totalChunks; i++) {
    const type = v.getUint16(off, true);
    const blocks = v.getUint32(off + 4, true);
    if (type === CHUNK_RAW || type === CHUNK_FILL) return pos;
    pos += blocks;
    off += v.getUint32(off + 8, true);
  }
  return Infinity;
}

export class MockPhone {
  constructor(usb, options = {}) {
    this.usb = usb;
    this.scale = options.scale ?? 0.2;
    this.lostReply = options.lostReply ?? true;
    this.writeSpeed = options.writeSpeed ?? 400e6;
    this.latency = options.latency || 0;
    this.lineageBoots = new Set([options.lineageBootSha256, ...(options.lineageBoots || [])].filter(Boolean));
    this.fastbootdMax = options.fastbootdMax || 256 * MiB;
    const stock = !!options.stock;
    const fw = (s) => ({ baseband: s, bootloader: "6450-0001_X_Boot_SM6450_LA2.0_U_18" });
    this.state = {
      stock,
      locked: stock && !options.unlocked,
      oemUnlock: options.oemUnlock !== "off",
      unlockCode: (options.unlockCode || "0123456789ABCDEF").toUpperCase(),
      unlockReboots: !!options.unlockReboots,
      slot: stock ? options.stockSlot || "b" : "a",
      firmware: { a: fw(options.fwA || "70.2.A.4.22"), b: fw(options.fwB || "70.2.A.4.22") },
      // What boot and recovery of each slot hold: stock, lineage or sailfish.
      boot: { a: stock ? "stock" : options.bootA || "lineage", b: stock ? "stock" : "none" },
      recovery: { a: stock ? "stock" : "lineage", b: stock ? "stock" : "none" },
      merge: options.merge || "none",
      ...initialSuper(stock ? options.stockSlot || "b" : "a", stock),
    };
    this.dev = null;
    this.where = "off";
    this.download = null;
    this.buffer = null;
    this.written = {};
    this.commands = [];
  }

  later(ms, fn) {
    setTimeout(fn, Math.max(1, ms * this.scale));
  }

  plugIn(mode) {
    this.unplug();
    this.where = mode;
    this.dev = new MockDevice(this, mode);
    this.usb._attach(this.dev);
  }

  unplug() {
    const d = this.dev;
    this.dev = null;
    if (d) {
      d.unplug();
      this.usb._detach(d);
    }
  }

  // The user switches the phone off and starts it in fastboot mode (volume up + USB).
  enterFastboot() {
    this.plugIn("bootloader");
  }

  async receive(dev, data) {
    if (this.download) {
      const d = this.download;
      d.chunks.push(data);
      d.received += data.length;
      if (d.received > d.size) {
        this.download = null;
        dev.answer("FAILtoo much data");
      } else if (d.received === d.size) {
        this.download = null;
        this.buffer = { chunks: d.chunks, size: d.size };
        dev.answer("OKAY");
      }
      return;
    }
    const cmd = new TextDecoder().decode(data);
    this.commands.push(`${dev.mode}: ${cmd.startsWith("oem unlock") ? "oem unlock (code)" : cmd}`);
    await this.command(dev, cmd);
  }

  bootloaderVars() {
    const s = this.state;
    const f = s.firmware[s.slot];
    return {
      product: "XQ-ES54",
      secure: s.locked ? "yes" : "no",
      unlocked: s.locked ? "no" : "yes",
      "version-baseband": f.baseband,
      "version-bootloader": f.bootloader,
    };
  }

  getvar(mode, name) {
    const s = this.state;
    if (mode === "bootloader") {
      const vars = this.bootloaderVars();
      if (name in vars) return "OKAY" + vars[name];
      return `FAIL${name.slice(0, 10)} not supported`;
    }
    if (name === "is-userspace") return "OKAYyes";
    if (name === "current-slot") return "OKAY" + s.slot;
    if (name === "snapshot-update-status") return "OKAY" + s.merge;
    if (name === "max-download-size") return "OKAY0x" + this.fastbootdMax.toString(16);
    if (name === "product") return "OKAYpdx246";
    if (name === "secure") return "OKAYno";
    if (name === "partition-size:super") return "OKAY0x" + SUPER_SIZE.toString(16).toUpperCase();
    if (name.startsWith("is-logical:")) {
      const p = name.slice(11);
      if (s.logical.has(p)) return "OKAYyes";
      if (PHYSICAL.includes(p)) return "OKAYno";
      return "FAILNo such partition.";
    }
    return "FAILVariable not implemented.";
  }

  // Sony's bootloader answers getvar:all with one INFO line per variable, the serial number
  // among them; it is also where it reports the active slot.
  getvarAll(dev) {
    const s = this.state;
    const lines = Object.entries(this.bootloaderVars()).map(([k, v]) => `${k}:${v}`);
    lines.push(`serialno:${dev.serialNumber}`, `current-slot:${s.slot}`, "slot-count:2");
    for (const x of ["a", "b"]) {
      lines.push(`slot-successful:${x}:${x === s.slot ? "yes" : "no"}`, `slot-unbootable:${x}:no`, `slot-retry-count:${x}:7`);
    }
    lines.push("partition-size:boot_a:0x6000000", "partition-type:userdata:f2fs");
    for (const l of lines) dev.answer("INFO" + l);
    dev.answer("OKAY");
  }

  async command(dev, cmd) {
    const s = this.state;
    const colon = cmd.indexOf(":");
    const name = colon < 0 ? cmd : cmd.slice(0, colon);
    const arg = colon < 0 ? "" : cmd.slice(colon + 1);
    const fastbootd = dev.mode === "fastbootd";
    if (cmd.startsWith("oem unlock")) return this.oemUnlock(dev, cmd.slice(10).trim());
    if (s.locked && ["flash", "erase", "set_active", "update-super", "resize-logical-partition"].includes(name)) {
      return dev.answer(name === "set_active" ? "FAILSlot Change is not allowed in Lock State" : "FAILFlashing is not allowed in Lock State");
    }
    switch (name) {
      case "getvar":
        if (arg === "all") return this.getvarAll(dev);
        return dev.answer(this.getvar(dev.mode, arg));
      case "download": {
        const size = parseInt(arg, 16);
        const max = fastbootd ? this.fastbootdMax : 256 * MiB;
        if (!(size > 0) || size > max) return dev.answer("FAILRequested download size is more than max allowed");
        this.download = { size, received: 0, chunks: [] };
        return dev.answer("DATA" + arg);
      }
      case "flash":
        return this.flash(dev, arg);
      case "set_active":
        if (arg !== "a" && arg !== "b") return dev.answer("FAILInvalid slot");
        s.slot = arg;
        return dev.answer("OKAY");
      case "resize-logical-partition":
        if (!fastbootd) return dev.answer("FAILunknown command");
        return this.resize(dev, arg);
      case "update-super":
        if (!fastbootd) return dev.answer("FAILunknown command");
        return this.updateSuper(dev, arg);
      case "snapshot-update":
        if (!fastbootd) return dev.answer("FAILunknown command");
        if (arg === "cancel") {
          s.merge = "none";
          return dev.answer("OKAYSuccess");
        }
        return dev.answer("FAILInvalid parameter to snapshot-update");
      case "erase":
        return dev.answer("OKAY");
      case "reboot":
        return this.reboot(dev, "");
      case "reboot-bootloader":
        return this.reboot(dev, "bootloader");
      case "reboot-fastboot":
        return this.reboot(dev, "fastboot");
      default:
        return dev.answer("FAILunknown command");
    }
  }

  oemUnlock(dev, arg) {
    const s = this.state;
    if (dev.mode !== "bootloader") return dev.answer("FAILunknown command");
    if (!s.locked) return dev.answer("FAILDevice already unlocked");
    if (!s.oemUnlock) return dev.answer("FAILUnlock not allowed");
    if (arg.replace(/^0x/i, "").toUpperCase() !== s.unlockCode) return dev.answer("FAILIncorrect unlock code");
    s.locked = false;
    dev.answer("OKAY");
    if (s.unlockReboots) {
      this.later(300, () => {
        this.unplug();
        this.where = "restarting";
        this.later(3000, () => this.plugIn("bootloader"));
      });
    }
  }

  // fastbootd's update-super: the downloaded table, checked as liblp checks it, replaces
  // the one of super (only with "wipe", the way this page uses it).
  updateSuper(dev, arg) {
    const s = this.state;
    const buf = this.buffer;
    this.buffer = null;
    const [part, wipe] = arg.split(":");
    if (!buf) return dev.answer("FAILNo data available");
    if (part !== "super") return dev.answer(`FAILCannot find ${part}`);
    if (wipe !== "wipe") return dev.answer("FAILupdate-super without wipe is not simulated");
    let t;
    try {
      t = parseSuperImage(concatBytes(buf.chunks, buf.size));
    } catch (e) {
      return dev.answer(`FAILData is not a valid logical partition metadata image (${e.message})`);
    }
    const sup = t.blockDevices[0];
    if (sup.name !== "super" || sup.size !== SUPER_SIZE) {
      return dev.answer(`FAILBlock device super size mismatch (expected ${sup.size}, got ${SUPER_SIZE})`);
    }
    s.table = t;
    s.groups = new Map(t.groups.map((g) => [g.name, g.maxSize]));
    s.logical = new Map(t.partitions.map((p) => [p.name, { size: p.size, group: p.group }]));
    return dev.answer("OKAYSuccessfully flashed partition table");
  }

  resize(dev, arg) {
    const s = this.state;
    const [p, sizeText] = arg.split(":");
    const size = Number(sizeText);
    const part = s.logical.get(p);
    if (!part) return dev.answer("FAILNo such partition.");
    if (s.merge !== "none") return dev.answer("FAILCannot resize while a snapshot update is in progress");
    let group = 0;
    let total = 0;
    for (const [name, q] of s.logical) {
      const n = name === p ? size : q.size;
      total += n;
      if (q.group === part.group) group += n;
    }
    const max = s.groups.get(part.group) || 0;
    if ((max && group > max) || total > SUPER_SIZE - MiB) return dev.answer("FAILNot enough space to resize partition");
    part.size = size;
    return dev.answer("OKAYPartition resized");
  }

  async flash(dev, p) {
    const s = this.state;
    const buf = this.buffer;
    this.buffer = null;
    if (!buf) return dev.answer("FAILNo data downloaded");
    const logical = s.logical.has(p);
    if (logical && dev.mode !== "fastbootd") return dev.answer("FAILPartition not found");
    if (!logical && !PHYSICAL.includes(p)) return dev.answer("FAILPartition not found");
    if (dev.mode === "fastbootd" && (logical || p === "userdata") && s.merge !== "none") {
      return dev.answer(`FAILCannot flash ${p} while a snapshot update is in progress`);
    }
    const data = concatBytes(buf.chunks, buf.size);
    buf.chunks.length = 0;
    try {
      const sparse = parseSparseHeader(data);
      if (sparse) {
        const bytes = sparse.totalBlocks * sparse.blockSize;
        if (logical && bytes > s.logical.get(p).size) return dev.answer("FAILImage is too large for the partition");
        let rec = this.written[p];
        if (!rec || rec.kind !== "sparse" || firstDataBlock(data) < rec.digest.next) {
          rec = { kind: "sparse", digest: new BlockDigest(sparse.blockSize), pieces: 0, totalBlocks: sparse.totalBlocks };
          this.written[p] = rec;
        }
        if (sparse.totalBlocks !== rec.totalBlocks) return dev.answer("FAILInconsistent sparse pieces");
        rec.digest.applySparse(data);
        rec.pieces++;
      } else {
        if (logical && data.length > s.logical.get(p).size) return dev.answer("FAILImage is too large for the partition");
        const sha = new Sha256().update(data).hex();
        this.written[p] = { kind: "raw", sha256: sha, size: data.length, pieces: 1 };
        const m = /^(boot|recovery)_([ab])$/.exec(p);
        if (m && m[1] === "boot") s.boot[m[2]] = this.lineageBoots.has(sha) ? "lineage" : "sailfish";
        if (m && m[1] === "recovery") s.recovery[m[2]] = "lineage"; // only LineageOS's is ever written
      }
    } catch (e) {
      return dev.answer(`FAILInvalid image: ${e.message}`);
    }
    await sleep((data.length / this.writeSpeed) * 1000 * this.scale);
    dev.answer("OKAY");
  }

  reboot(dev, target) {
    const s = this.state;
    const from = dev.mode;
    if (!(target === "fastboot" && from === "bootloader" && this.lostReply)) dev.answer("OKAY");
    this.later(300, () => {
      this.unplug();
      const boot = s.boot[s.slot];
      if (target === "bootloader") {
        this.where = "restarting";
        this.later(3000, () => this.plugIn("bootloader"));
      } else if (target === "fastboot" && (from === "fastbootd" || (boot === "lineage" && s.recovery[s.slot] === "lineage"))) {
        this.where = "restarting";
        this.later(6000, () => this.plugIn("fastbootd"));
      } else if (target === "fastboot" && boot === "lineage") {
        this.where = "Sony's recovery (no fastbootd)";
      } else {
        // A normal restart, or boot holds Sailfish OS or Sony's Android: no fastboot device.
        this.where = { lineage: "lineageos", sailfish: "sailfishos", stock: "Sony's Android" }[boot] || "no system";
      }
    });
  }

  // Digests of everything written, for comparing with tools/sparse_digest.py.
  results() {
    const out = {};
    for (const [p, rec] of Object.entries(this.written)) {
      if (rec.kind === "sparse") {
        if (!rec.hex) rec.hex = rec.digest.hex();
        out[p] = { kind: "sparse", digest: rec.hex, blocks: rec.digest.blocks, pieces: rec.pieces };
      } else {
        out[p] = { kind: "raw", sha256: rec.sha256, size: rec.size };
      }
    }
    return out;
  }
}

const SUPER_SIZE = 17179869184;

// The dynamic partitions at the start: LineageOS's on slot a, or Sony's on its active slot.
function initialSuper(slot, stock) {
  const sizes = stock
    ? { system: 1300 * MiB, system_ext: 400 * MiB, product: 900 * MiB, vendor: 1100 * MiB, vendor_dlkm: 60 * MiB, odm: 3 * MiB }
    : { system: 1200 * MiB, system_ext: 300 * MiB, product: 600 * MiB, vendor: 900 * MiB, vendor_dlkm: 69554176, odm: 4 * MiB };
  const group = `somc_dynamic_partitions_${slot}`;
  const logical = new Map();
  for (const [name, size] of Object.entries(sizes)) logical.set(`${name}_${slot}`, { size, group });
  const groups = new Map([["default", 0], ["somc_dynamic_partitions_a", 17175674880], ["somc_dynamic_partitions_b", 17175674880]]);
  return { logical, groups, table: null };
}

// Like Chrome, the simulation keeps permissions for devices with a serial number across page
// loads (here in localStorage), so a second run finds a known identity by itself.
const ALLOWED_KEY = "sfos-installer-mock:allowed";

export class MockUSB extends EventTarget {
  constructor({ resetPermissions = false } = {}) {
    super();
    this.devices = [];
    this.allowed = new Set();
    try {
      if (resetPermissions) localStorage.removeItem(ALLOWED_KEY);
      for (const k of JSON.parse(localStorage.getItem(ALLOWED_KEY) || "[]")) this.allowed.add(k);
    } catch {
      // no storage: permissions last for this page only
    }
  }

  key(d) {
    return `${d.vendorId}:${d.productId}:${d.serialNumber}`;
  }

  allow(d) {
    this.allowed.add(this.key(d));
    try {
      localStorage.setItem(ALLOWED_KEY, JSON.stringify([...this.allowed]));
    } catch {
      // ignore
    }
  }

  async getDevices() {
    return this.devices.filter((d) => this.allowed.has(this.key(d)));
  }

  // The browser's chooser needs a user gesture; this one picks the simulated phone.
  async requestDevice() {
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      throw domError("SecurityError", "Must be handling a user gesture to show a permission request.");
    }
    const d = this.devices[0];
    if (!d) throw domError("NotFoundError", "No device selected.");
    this.allow(d);
    return d;
  }

  _attach(d) {
    this.devices.push(d);
    if (this.allowed.has(this.key(d))) this.fire("connect", d);
  }

  _detach(d) {
    this.devices = this.devices.filter((x) => x !== d);
    if (this.allowed.has(this.key(d))) this.fire("disconnect", d);
  }

  fire(type, device) {
    const e = new Event(type);
    e.device = device;
    this.dispatchEvent(e);
  }
}

export function createMock(options = {}) {
  const usb = new MockUSB({ resetPermissions: options.resetPermissions });
  const phone = new MockPhone(usb, options);
  phone.plugIn(options.startMode || "bootloader");
  return { usb, phone };
}
