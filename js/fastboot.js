// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// The fastboot protocol over WebUSB, following AOSP's host side
// (system/core/fastboot/fastboot_driver.cpp): a command is one USB write, the answer is
// read in packets of up to 256 bytes (INFO and TEXT lines, then OKAY, FAIL or DATA), and a
// download sends "download:%08x", gets DATA back, streams the bytes and waits for OKAY.

export const FASTBOOT_FILTER = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 };

// Host fastboot on Linux writes in URBs of at most 256 KiB (usb_linux.cpp), and never ends a
// write in the middle of a download with a short packet; neither does this. Several transfers
// are kept in flight: waiting for each one before starting the next leaves the bus idle for a
// browser round trip every 256 KiB (6.7 MB/s through a VM, against 9 MB/s for host fastboot).
// The order of transfers on one endpoint is kept by the browser and the operating system.
export const TRANSFER_SIZE = 256 * 1024;
export const TRANSFERS_IN_FLIGHT = 4;
const COMMAND_TIMEOUT = 30000; // RESP_TIMEOUT in fastboot_driver.h
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class FastbootError extends Error {
  // kind: "fail" (the phone answered FAIL), "usb" (transfer failed or device gone),
  // "timeout", "protocol" (unexpected answer), "access" (the browser may not open it)
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "FastbootError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function usbError(e, what) {
  if (e instanceof FastbootError) return e;
  const name = e && e.name;
  if (name === "SecurityError") {
    return new FastbootError("access", "The browser was not allowed to open the phone.", { cause: e });
  }
  if (name === "NotFoundError") {
    return new FastbootError("usb", "The phone was disconnected.", { cause: e });
  }
  return new FastbootError("usb", `USB ${what} failed: ${e && e.message ? e.message : e}`, { cause: e });
}

export function findFastbootInterface(device) {
  for (const conf of device.configurations || []) {
    for (const iface of conf.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== 0xff || alt.interfaceSubclass !== 0x42 || alt.interfaceProtocol !== 0x03) continue;
        const epIn = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "in");
        const epOut = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "out");
        if (epIn && epOut) {
          return {
            configuration: conf.configurationValue,
            interface: iface.interfaceNumber,
            alternate: alt.alternateSetting,
            epIn,
            epOut,
          };
        }
      }
    }
  }
  return null;
}

export class FastbootDevice {
  // readOnly: refuse every command except getvar, before anything is sent.
  // transferSize, inFlight: download tuning (defaults above).
  static async open(usbDevice, { log, readOnly = false, transferSize, inFlight } = {}) {
    const found = findFastbootInterface(usbDevice);
    if (!found) throw new FastbootError("protocol", "This USB device has no fastboot interface.");
    try {
      if (!usbDevice.opened) await usbDevice.open();
      if (!usbDevice.configuration || usbDevice.configuration.configurationValue !== found.configuration) {
        await usbDevice.selectConfiguration(found.configuration);
      }
      await usbDevice.claimInterface(found.interface);
      if (found.alternate !== 0) await usbDevice.selectAlternateInterface(found.interface, found.alternate);
    } catch (e) {
      const err = usbError(e, "open");
      if (e && e.name === "NetworkError") {
        err.kind = "busy";
        err.message =
          "The phone is in use by another program (for example fastboot, adb or fwupd), or the browser cannot open it.";
      }
      throw err;
    }
    const fb = new FastbootDevice(usbDevice, found, log, readOnly);
    if (transferSize > 0) fb.transferSize = transferSize;
    if (inFlight > 0) fb.inFlight = inFlight;
    return fb;
  }

  constructor(usbDevice, found, log, readOnly = false) {
    this.usb = usbDevice;
    this.iface = found.interface;
    this.epIn = found.epIn.endpointNumber;
    this.epOut = found.epOut.endpointNumber;
    this.packetSizeIn = found.epIn.packetSize;
    this.packetSizeOut = found.epOut.packetSize;
    this.inSize = Math.max(512, found.epIn.packetSize || 0);
    this.readOnly = readOnly;
    this.transferSize = TRANSFER_SIZE;
    this.inFlight = TRANSFERS_IN_FLIGHT;
    this.log = log || (() => {});
    this.gone = false;
    this.broken = false;
  }

  get vendorId() {
    return this.usb.vendorId;
  }

  get productId() {
    return this.usb.productId;
  }

  markGone() {
    this.gone = true;
  }

  async close() {
    if (this.gone) return;
    this.gone = true;
    try {
      await this.usb.releaseInterface(this.iface);
    } catch {
      // ignore
    }
    try {
      await this.usb.close();
    } catch {
      // ignore
    }
  }

  checkUsable() {
    if (this.gone) throw new FastbootError("usb", "The phone was disconnected.");
    if (this.broken) {
      throw new FastbootError("usb", "The connection to the phone is out of step; connect it again.");
    }
  }

  async write(bytes) {
    let r;
    try {
      r = await this.usb.transferOut(this.epOut, bytes);
    } catch (e) {
      throw usbError(e, "write");
    }
    if (r.status !== "ok" || r.bytesWritten !== bytes.byteLength) {
      throw new FastbootError("usb", `USB write failed (${r.status}).`);
    }
  }

  async readPacket(timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // A WebUSB transfer cannot be cancelled: the next answer would go to it.
        this.broken = true;
        reject(new FastbootError("timeout", "The phone did not answer in time."));
      }, timeoutMs);
    });
    try {
      const r = await Promise.race([this.usb.transferIn(this.epIn, this.inSize), timeout]);
      if (r.status !== "ok") throw new FastbootError("usb", `USB read failed (${r.status}).`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    } catch (e) {
      throw usbError(e, "read");
    } finally {
      clearTimeout(timer);
    }
  }

  // Reads INFO/TEXT lines until OKAY, DATA or FAIL. The timeout restarts with every line.
  // INFO lines go to the log, or into `collect` (an array) without being logged.
  async response(timeoutMs = COMMAND_TIMEOUT, collect = null) {
    for (;;) {
      const text = decoder.decode(await this.readPacket(timeoutMs));
      const status = text.slice(0, 4);
      const payload = text.slice(4);
      if (status === "INFO" || status === "TEXT") {
        if (collect && status === "INFO") collect.push(payload);
        else if (payload.trim()) this.log(`(phone) ${payload.trim()}`);
        continue;
      }
      if (status === "OKAY") return { status, value: payload };
      if (status === "DATA") return { status, value: payload, size: parseInt(payload, 16) };
      if (status === "FAIL") {
        throw new FastbootError("fail", `The phone answered: ${payload || "FAILED"}`, { remote: payload });
      }
      throw new FastbootError("protocol", `The phone sent an unexpected answer: ${JSON.stringify(text.slice(0, 64))}`);
    }
  }

  // Sends one command and returns its OKAY value. Logs it like host fastboot does, or as
  // `logAs` (for a command that holds a secret).
  async command(cmd, { timeoutMs = COMMAND_TIMEOUT, quiet = false, logAs = null, collect = null } = {}) {
    this.checkUsable();
    if (this.readOnly && !cmd.startsWith("getvar:")) {
      throw new FastbootError("refused", `Read-only mode: “${logAs || cmd}” was not sent.`);
    }
    if (cmd.length > 4096) throw new FastbootError("protocol", "Command too long.");
    if (!quiet) this.log(`>> ${logAs || cmd}`);
    await this.write(encoder.encode(cmd));
    try {
      const r = await this.response(timeoutMs, collect);
      if (!quiet) this.log(`<< ${r.status}${r.value ? " " + r.value : ""}`);
      return r;
    } catch (e) {
      if (!quiet) this.log(`<< ${e.kind === "fail" ? "FAIL " + (e.remote || "") : e.message}`);
      throw e;
    }
  }

  async getVar(name) {
    const r = await this.command(`getvar:${name}`);
    return r.value.trim();
  }

  // The value, or null if the phone answers FAIL (the variable is not supported).
  async tryGetVar(name) {
    try {
      return await this.getVar(name);
    } catch (e) {
      if (e.kind === "fail") return null;
      throw e;
    }
  }

  // getvar:all, as a Map of name to value ("slot-successful:a" -> "yes"). Its lines are not
  // logged: they include the serial number.
  async getVarAll() {
    const lines = [];
    await this.command("getvar:all", { collect: lines });
    const vars = new Map();
    for (const line of lines) {
      const i = line.lastIndexOf(":");
      if (i > 0) vars.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    return vars;
  }

  // Sends `size` bytes from `parts` (an iterable or async iterable of Uint8Array).
  async download(parts, size, onProgress) {
    if (size <= 0 || size > 0xffffffff) throw new FastbootError("protocol", "Invalid download size.");
    const hex = size.toString(16).padStart(8, "0");
    const r = await this.command(`download:${hex}`);
    if (r.status !== "DATA" || r.size !== size) {
      throw new FastbootError("protocol", `The phone is not ready for the download (${r.status} ${r.value}).`);
    }
    const started = performance.now();
    const chunk = this.transferSize;
    const queue = []; // transfers in flight, oldest first
    let completed = 0;
    const settle = async () => {
      const t = queue.shift();
      await t.promise;
      completed += t.length;
      if (onProgress) onProgress(completed, size);
    };
    // Every transfer gets its own buffer: a buffer must not change while its transfer runs.
    const submit = async (bytes) => {
      const promise = this.write(bytes);
      promise.catch(() => {}); // awaited in settle(); after a failure the rest are dropped
      queue.push({ promise, length: bytes.length });
      if (queue.length >= this.inFlight) await settle();
    };
    let stage = new Uint8Array(chunk);
    let fill = 0;
    let sent = 0;
    try {
      for await (const part of parts) {
        let off = 0;
        while (off < part.length) {
          if (sent + (part.length - off) > size) throw new FastbootError("protocol", "More data than announced.");
          if (fill === 0 && part.length - off >= chunk) {
            await submit(part.subarray(off, off + chunk));
            off += chunk;
            sent += chunk;
          } else {
            const take = Math.min(part.length - off, chunk - fill);
            stage.set(part.subarray(off, off + take), fill);
            fill += take;
            off += take;
            sent += take;
            if (fill === chunk) {
              await submit(stage);
              stage = new Uint8Array(chunk);
              fill = 0;
            }
          }
        }
      }
      if (fill > 0) await submit(stage.subarray(0, fill));
      while (queue.length) await settle();
    } catch (e) {
      // The phone still waits for the rest of the download: this connection cannot go on.
      this.broken = true;
      throw e;
    }
    if (sent !== size) throw new FastbootError("protocol", `Sent ${sent} of ${size} bytes.`);
    const done = await this.response();
    if (done.status !== "OKAY") throw new FastbootError("protocol", `Unexpected answer after the download: ${done.status}`);
    const seconds = (performance.now() - started) / 1000;
    this.log(`   sent ${size} bytes in ${seconds.toFixed(1)} s (${(size / 1e6 / Math.max(seconds, 0.001)).toFixed(1)} MB/s)`);
  }
}
