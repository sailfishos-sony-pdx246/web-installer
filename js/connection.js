// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Keeps track of the phone across reboots. The browser treats every USB identity as a
// separate device: the bootloader and fastbootd have different vendor and product IDs, so
// the first time the phone shows up in a new mode, the user has to pick it in the browser's
// device chooser (that needs a click). Once allowed, a device that comes back is found by
// polling navigator.usb.getDevices().

import { FastbootDevice, FASTBOOT_FILTER, findFastbootInterface } from "./fastboot.js";
import { sleep } from "./bytes.js";

export const MODE_LABELS = {
  bootloader: "the bootloader's fastboot mode",
  fastbootd: "fastbootd",
  unknown: "an unknown fastboot mode",
};

export class Connection extends EventTarget {
  constructor(usb, profile, log, { readOnly = false, transferSize, inFlight } = {}) {
    super();
    this.usb = usb;
    this.profile = profile;
    this.log = log;
    this.readOnly = readOnly;
    this.transferSize = transferSize;
    this.inFlight = inFlight;
    this.fb = null;
    this.mode = null;
    this.serial = null;
    this.waiter = null;
    this.lock = Promise.resolve();
    usb.addEventListener("disconnect", (e) => {
      if (this.fb && e.device === this.fb.usb) {
        this.fb.markGone();
        this.fb = null;
        this.mode = null;
        this.log("-- the phone disconnected");
        this.changed();
      }
    });
    usb.addEventListener("connect", (e) => {
      if (this.waiter) this.offer(e.device, false).catch(() => {});
    });
  }

  get connected() {
    return !!this.fb && !this.fb.gone;
  }

  changed() {
    this.dispatchEvent(new Event("change"));
  }

  modeOf(dev) {
    return this.profile.modeOf(dev.vendorId, dev.productId);
  }

  async attach(dev) {
    if (this.serial && dev.serialNumber && dev.serialNumber !== this.serial) {
      throw new Error("This is a different phone than the one connected before.");
    }
    if (this.fb && this.fb.usb !== dev) await this.release();
    const fb = await FastbootDevice.open(dev, {
      log: this.log,
      readOnly: this.readOnly,
      transferSize: this.transferSize,
      inFlight: this.inFlight,
    });
    let mode = this.modeOf(dev);
    if (mode === "unknown") {
      const v = await fb.tryGetVar("is-userspace");
      mode = v === "yes" ? "fastbootd" : "bootloader";
    }
    this.fb = fb;
    this.mode = mode;
    if (dev.serialNumber) this.serial = dev.serialNumber;
    this.log(`-- connected: ${dev.manufacturerName || ""} ${dev.productName || ""} in ${MODE_LABELS[mode]}`.replace(/ +/g, " "));
    this.changed();
    return fb;
  }

  // Must be called directly from a click handler: shows the browser's device chooser.
  async choose() {
    const dev = await this.usb.requestDevice({ filters: [FASTBOOT_FILTER] });
    const fb = await this.offer(dev, true);
    return fb;
  }

  // A device appeared (chooser, connect event or poll). Takes it if it is what we wait for.
  // One at a time, so that a poll and the chooser never open the same device twice.
  offer(dev, fromChooser) {
    const run = this.lock.then(() => this.offerNow(dev, fromChooser));
    this.lock = run.catch(() => {});
    return run;
  }

  async offerNow(dev, fromChooser) {
    if (!findFastbootInterface(dev)) {
      if (fromChooser) throw new Error("This USB device is not a phone in fastboot mode.");
      return null;
    }
    if (this.fb && this.fb.usb === dev && !this.fb.gone) {
      if (this.waiter && this.mode === this.waiter.mode) this.resolveWaiter();
      return this.fb;
    }
    if (this.waiter) {
      const want = this.waiter.mode;
      const mode = this.modeOf(dev);
      if (mode !== "unknown" && mode !== want) {
        if (fromChooser) throw new Error(`The phone is in ${MODE_LABELS[mode]}, not in ${MODE_LABELS[want]}.`);
        return null;
      }
      await this.attach(dev);
      if (this.mode !== want) {
        if (fromChooser) throw new Error(`The phone is in ${MODE_LABELS[this.mode]}, not in ${MODE_LABELS[want]}.`);
        return null;
      }
      this.resolveWaiter();
      return this.fb;
    }
    if (fromChooser) return this.attach(dev);
    return null;
  }

  resolveWaiter() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w.resolve(this.fb);
    this.changed();
  }

  // Resolves when the phone is connected in `mode`; the UI offers choose() meanwhile.
  waitFor(mode) {
    if (this.connected && this.mode === mode) return Promise.resolve(this.fb);
    if (this.waiter) this.waiter.reject(new Error("superseded"));
    const p = new Promise((resolve, reject) => {
      this.waiter = { mode, resolve, reject, since: Date.now() };
    });
    this.changed();
    this.poll();
    return p;
  }

  async poll() {
    const waiter = this.waiter;
    while (this.waiter === waiter && waiter) {
      try {
        for (const dev of await this.usb.getDevices()) {
          if (this.waiter !== waiter) break;
          if (this.fb && this.fb.usb === dev) continue;
          try {
            await this.offer(dev, false);
          } catch (e) {
            this.log(`-- could not open a fastboot device: ${e.message}`);
          }
        }
      } catch (e) {
        this.log(`-- getDevices failed: ${e.message}`);
      }
      await sleep(1000);
    }
  }

  cancelWait(error) {
    const w = this.waiter;
    this.waiter = null;
    if (w) w.reject(error);
    this.changed();
  }

  // Resolves when the current device disconnects, or after `ms`.
  async waitForDisconnect(ms) {
    if (!this.fb) return true;
    const fb = this.fb;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fb.gone || this.fb !== fb) return true;
      await sleep(100);
    }
    return false;
  }

  async release() {
    const fb = this.fb;
    this.fb = null;
    this.mode = null;
    if (fb) await fb.close();
    this.changed();
  }
}
