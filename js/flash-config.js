// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Reads flash-config.sh, the configuration of droid-hal-configs' generic flash.sh
// (sparse/boot/flash.sh), and turns its FLASH_OPS into steps. Only the subset of bash that
// these files use is understood: arrays NAME=( "..." ... ), assignments NAME="..." (also
// over several lines) and comments. Every operation is checked before the phone is touched,
// like flash.sh's dry run; anything this page cannot do stops the installation there.

export function parseFlashConfig(text) {
  const arrays = {};
  const vars = {};
  let i = 0;
  const n = text.length;

  const skipSpace = () => {
    while (i < n) {
      if (text[i] === "#") {
        while (i < n && text[i] !== "\n") i++;
      } else if (/\s/.test(text[i])) {
        i++;
      } else {
        break;
      }
    }
  };

  // One shell word: quoted or bare parts until unquoted whitespace, ')' or ';'.
  const readWord = () => {
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(text[i + 1])) {
            if (text[i + 1] !== "\n") out += text[i + 1];
            i += 2;
          } else {
            out += text[i++];
          }
        }
        if (i >= n) throw new Error("flash-config.sh: unterminated quote");
        i++;
      } else if (c === "'") {
        i++;
        while (i < n && text[i] !== "'") out += text[i++];
        if (i >= n) throw new Error("flash-config.sh: unterminated quote");
        i++;
      } else if (/[\s);]/.test(c)) {
        break;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };

  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text.slice(i, i + 200));
    if (!m) {
      while (i < n && text[i] !== "\n") i++; // export, functions, other commands: not needed
      continue;
    }
    const name = m[1];
    i += m[0].length;
    if (text[i] === "(") {
      i++;
      const items = [];
      for (;;) {
        skipSpace();
        if (i >= n) throw new Error(`flash-config.sh: ${name}=( is not closed`);
        if (text[i] === ")") {
          i++;
          break;
        }
        items.push(readWord());
      }
      arrays[name] = items;
    } else {
      vars[name] = readWord();
    }
  }
  return {
    products: arrays.VALID_PRODUCTS || [],
    ops: arrays.FLASH_OPS || [],
    vars,
  };
}

// Turns FLASH_OPS into a list of operations, checking each one against the device profile.
// Returns { checks, ops, problems }.
export function planFlashOps(config, profile, images) {
  const checks = [];
  const ops = [];
  const problems = [];
  for (const line of config.ops) {
    // flash.sh: read var_op var_arg1 var_arg2 <<< "$flash_op"
    const words = line.trim().split(/\s+/);
    const op = words[0];
    if (op === "getvar_fail_if") {
      if (words.length !== 3) {
        problems.push(`"${line}": expected a variable name and a value`);
        continue;
      }
      checks.push({ name: words[1], value: words[2], message: (config.vars[`GETVAR_ERROR_${words[1]}`] || "").trim() });
    } else if (op === "flash" || op === "flash_dont_fail") {
      const [, partition, file] = words;
      if (words.length !== 3) problems.push(`"${line}": expected a partition and an image`);
      else if (!profile.allowedPartitions.includes(partition)) problems.push(`"${line}": this page does not write ${partition}`);
      else if (!images.has(file)) problems.push(`"${line}": ${file} is not in the zip`);
      else ops.push({ kind: "flash", partition, file, retries: op === "flash_dont_fail" ? 30 : 0, line });
    } else if (op === "run") {
      const cmd = words[1];
      const args = words.slice(2);
      if (cmd === "fastboot") {
        const f = fastbootOp(args, profile);
        if (f) ops.push({ ...f, line });
        else problems.push(`"${line}": this fastboot command is not supported here`);
      } else if (cmd === "sleep" && args.length === 1 && /^\d+$/.test(args[0])) {
        ops.push({ kind: "sleep", seconds: Number(args[0]), line });
      } else if (profile.scripts && profile.scripts[cmd]) {
        ops.push({ kind: "script", script: cmd, args, line });
      } else {
        problems.push(`"${line}": this page cannot run ${cmd}`);
      }
    } else {
      problems.push(`"${line}": the operation ${op} is not supported here`);
    }
  }
  if (!ops.some((o) => o.kind === "flash")) problems.push("FLASH_OPS writes no partition");
  return { checks, ops, problems };
}

function fastbootOp(args, profile) {
  const a = args.join(" ");
  let m = /^--set-active=([ab])$/.exec(a) || /^set_active ([ab])$/.exec(a);
  if (m) return { kind: "set-active", slot: m[1] };
  if (a === "reboot") return { kind: "reboot", target: "" };
  if (a === "reboot bootloader" || a === "reboot-bootloader") return { kind: "reboot", target: "bootloader" };
  if (a === "reboot fastboot") return { kind: "reboot", target: "fastboot" };
  m = /^erase (\S+)$/.exec(a);
  if (m && profile.allowedPartitions.includes(m[1])) return { kind: "erase", partition: m[1] };
  return null;
}
