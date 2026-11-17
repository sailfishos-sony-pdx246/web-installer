// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Getting the user's attention when the page needs them while they look elsewhere: a short
// chime, a flashing tab title, and the keyboard focus on the button to press. Browsers let a
// page play sound only after an interaction, so the audio context is made during the Start
// click and used later.

const PATTERNS = {
  attention: [
    [660, 0],
    [880, 0.16],
    [660, 0.32],
    [880, 0.48],
  ],
  done: [
    [523, 0],
    [659, 0.14],
    [784, 0.28],
    [1047, 0.42],
  ],
  error: [
    [392, 0],
    [311, 0.22],
  ],
};

const PREFIX = "sfos-installer:";

// localStorage can be missing or throw (private windows, blocked site data): then the page
// simply has no memory.
export const store = {
  get(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch {
      // ignore
    }
  },
  removeAll(prefix) {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX + prefix)) localStorage.removeItem(k);
    } catch {
      // ignore
    }
  },
};

export class Cues {
  constructor() {
    this.ctx = null;
    this.baseTitle = document.title;
    this.timer = null;
    this.enabled = store.get("sound") !== "off";
    this.played = [];
  }

  // Call from a click handler.
  prepare() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    store.set("sound", on ? "on" : "off");
  }

  chime(kind) {
    this.played.push(kind);
    if (!this.enabled || !this.ctx) return;
    try {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      const t0 = this.ctx.currentTime + 0.03;
      for (const [freq, at] of PATTERNS[kind] || []) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.15);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + 0.16);
      }
    } catch {
      // no sound then
    }
  }

  // Shows `text` as the tab title, flashing unless flash is false; null restores the title.
  title(text, flash = true) {
    clearInterval(this.timer);
    this.timer = null;
    if (!text) {
      document.title = this.baseTitle;
      return;
    }
    document.title = text;
    if (flash) {
      let on = true;
      this.timer = setInterval(() => {
        on = !on;
        document.title = on ? text : this.baseTitle;
      }, 1000);
    }
  }
}
