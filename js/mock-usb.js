// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// A simulated Xperia 10 VI for testing the page without a phone (index.html?mock=1).
// It stands in for navigator.usb: the phone appears as a fastboot device with the USB
// identities of the real bootloader and fastbootd, answers like them (including the Sony
// bootloader's FAIL for long getvar names and the lost answer to reboot-fastboot), and
// records what is written. For sparse images it computes the same content digest as
// tools/sparse_digest.py, so a test can compare the result with the image files.

import { BlockDigest, parseSparseHeader, CHUNK_RAW, CHUNK_FILL } from "./sparse.js";
import { Sha256 } from "./sha256.js";
import { concatBytes, sleep } from "./bytes.js";

const MiB = 1024 * 1024;

const IDENTITIES = {
  // The Sony bootloader's USB strings, as read on a real phone (2026-11-17).
  bootloader: { vendorId: 0x0fce, productId: 0x0dde, manufacturerName: "Google", productName: "Android" },
  fastbootd: { vendorId: 0x18d1, productId: 0x4ee0, manufacturerName: "Sony", productName: "XQ-ES54" },
};

const BOOTLOADER_VARS = {
  product: "XQ-ES54",
  secure: "no",
  unlocked: "yes",
  "version-baseband": "70.2.A.4.22",
  "version-bootloader": "6450-0001_X_Boot_SM6450_LA2.0_U_18",
};

const PHYSICAL = [
  "boot_a", "boot_b", "vendor_boot_a", "vendor_boot_b", "dtbo_a", "dtbo_b", "recovery_a", "recovery_b",
  "vbmeta_a", "vbmeta_b", "userdata", "super", "metadata", "misc",
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
    this.lineageBootSha256 = options.lineageBootSha256 || null;
    this.state = {
      slot: "a",
      bootA: options.bootA || "lineage",
      merge: options.merge || "none",
      logical: {
        system_a: 1200 * MiB, system_ext_a: 300 * MiB, product_a: 600 * MiB,
        vendor_a: 900 * MiB, vendor_dlkm_a: 69554176, odm_a: 4 * MiB,
      },
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
    this.commands.push(`${dev.mode}: ${cmd}`);
    await this.command(dev, cmd);
  }

  getvar(mode, name) {
    if (mode === "bootloader") {
      if (name in BOOTLOADER_VARS) return "OKAY" + BOOTLOADER_VARS[name];
      return `FAIL${name.slice(0, 10)} not supported`;
    }
    const s = this.state;
    if (name === "is-userspace") return "OKAYyes";
    if (name === "current-slot") return "OKAY" + s.slot;
    if (name === "snapshot-update-status") return "OKAY" + s.merge;
    if (name === "max-download-size") return "OKAY0x10000000";
    if (name === "product") return "OKAYpdx246";
    if (name === "secure") return "OKAYno";
    if (name.startsWith("is-logical:")) {
      const p = name.slice(11);
      if (p in s.logical) return "OKAYyes";
      if (PHYSICAL.includes(p)) return "OKAYno";
      return "FAILNo such partition.";
    }
    return "FAILVariable not implemented.";
  }

  async command(dev, cmd) {
    const colon = cmd.indexOf(":");
    const name = colon < 0 ? cmd : cmd.slice(0, colon);
    const arg = colon < 0 ? "" : cmd.slice(colon + 1);
    const fastbootd = dev.mode === "fastbootd";
    switch (name) {
      case "getvar":
        return dev.answer(this.getvar(dev.mode, arg));
      case "download": {
        const size = parseInt(arg, 16);
        if (!(size > 0) || size > 256 * MiB) return dev.answer("FAILRequested download size is more than max allowed");
        this.download = { size, received: 0, chunks: [] };
        return dev.answer("DATA" + arg);
      }
      case "flash":
        return this.flash(dev, arg);
      case "set_active":
        if (arg !== "a" && arg !== "b") return dev.answer("FAILInvalid slot");
        this.state.slot = arg;
        return dev.answer("OKAY");
      case "resize-logical-partition": {
        if (!fastbootd) return dev.answer("FAILunknown command");
        const [p, size] = arg.split(":");
        if (!(p in this.state.logical)) return dev.answer("FAILNo such partition.");
        this.state.logical[p] = Number(size);
        return dev.answer("OKAY");
      }
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

  async flash(dev, p) {
    const buf = this.buffer;
    this.buffer = null;
    if (!buf) return dev.answer("FAILNo data downloaded");
    const logical = p in this.state.logical;
    if (logical && dev.mode !== "fastbootd") return dev.answer("FAILPartition not found");
    if (!logical && !PHYSICAL.includes(p)) return dev.answer("FAILPartition not found");
    if (dev.mode === "fastbootd" && p === "userdata" && this.state.merge !== "none") {
      return dev.answer("FAILCannot flash userdata while a snapshot update is pending");
    }
    const data = concatBytes(buf.chunks, buf.size);
    buf.chunks.length = 0;
    try {
      const sparse = parseSparseHeader(data);
      if (sparse) {
        const bytes = sparse.totalBlocks * sparse.blockSize;
        if (logical && bytes > this.state.logical[p]) return dev.answer("FAILImage is too large for the partition");
        let rec = this.written[p];
        if (!rec || rec.kind !== "sparse" || firstDataBlock(data) < rec.digest.next) {
          rec = { kind: "sparse", digest: new BlockDigest(sparse.blockSize), pieces: 0, totalBlocks: sparse.totalBlocks };
          this.written[p] = rec;
        }
        if (sparse.totalBlocks !== rec.totalBlocks) return dev.answer("FAILInconsistent sparse pieces");
        rec.digest.applySparse(data);
        rec.pieces++;
      } else {
        if (logical && data.length > this.state.logical[p]) return dev.answer("FAILImage is too large for the partition");
        const sha = new Sha256().update(data).hex();
        this.written[p] = { kind: "raw", sha256: sha, size: data.length, pieces: 1 };
        if (p === "boot_a") this.state.bootA = sha === this.lineageBootSha256 ? "lineage" : "sailfish";
      }
    } catch (e) {
      return dev.answer(`FAILInvalid image: ${e.message}`);
    }
    await sleep((data.length / this.writeSpeed) * 1000 * this.scale);
    dev.answer("OKAY");
  }

  reboot(dev, target) {
    const from = dev.mode;
    if (!(target === "fastboot" && from === "bootloader" && this.lostReply)) dev.answer("OKAY");
    this.later(300, () => {
      this.unplug();
      if (target === "bootloader") {
        this.where = "restarting";
        this.later(3000, () => this.plugIn("bootloader"));
      } else if (target === "fastboot" && (from === "fastbootd" || this.state.bootA === "lineage")) {
        this.where = "restarting";
        this.later(6000, () => this.plugIn("fastbootd"));
      } else {
        // boot_a holds Sailfish OS (or a normal reboot): the system starts, no fastboot device.
        this.where = this.state.bootA === "lineage" ? "lineageos" : "sailfishos";
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
