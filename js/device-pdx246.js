// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// Device profile for the Sony Xperia 10 VI (pdx246): USB identities, the partitions this
// page may write, known releases with their SHA-256 sums, and the pre-flight check of
// flash-preflight.sh (droid-config-pdx246, sparse/boot), which the image's flash-config.sh
// runs as "run ./flash-preflight.sh --reboot-fastboot".

export const MiB = 1024 * 1024;

export const pdx246 = {
  name: "Sony Xperia 10 VI",
  codename: "pdx246",

  // USB identities: Sony's bootloader in fastboot mode, and fastbootd of the LineageOS
  // recovery. Anything else is identified with getvar:is-userspace.
  modeOf(vendorId, productId) {
    if (vendorId === 0x0fce && productId === 0x0dde) return "bootloader";
    if (vendorId === 0x18d1 && productId === 0x4ee0) return "fastbootd";
    return "unknown";
  },

  // "vvvv:pppp" of a mode, for remembering which identities this browser has allowed.
  identityOf(mode) {
    return { bootloader: "0fce:0dde", fastbootd: "18d1:4ee0" }[mode] || null;
  },

  // The Sony bootloader answers getvar:max-download-size with FAIL (it garbles long variable
  // names), so host fastboot would send a whole image at once and be refused. 256 MiB pieces
  // are what "fastboot -S 256M" uses for super.img on this phone; fastbootd reports 256 MiB.
  maxDownloadSize: 256 * MiB,
  queryMaxDownloadIn: ["fastbootd"],

  // VALID_PRODUCTS of flash-config.sh, for the flow that uses no Sailfish OS zip.
  products: ["pdx246", "XQ-ES54", "XQ-ES72"],
  lockedCheck: {
    name: "secure",
    value: "yes",
    message:
      "The bootloader reports secure=yes: it looks locked. Only a phone with an unlocked bootloader can be flashed.",
  },

  // Everything any flow of this page writes; FLASH_OPS naming anything else is refused.
  allowedPartitions: ["boot_a", "vendor_boot_a", "dtbo_a", "recovery_a", "vendor_dlkm_a", "userdata"],

  releases: [
    {
      tag: "v5.2.0.22-20261120",
      file: "Sailfish_OS-5.2.0.22-pdx246-0.0.1.202611202002.zip",
      size: 885779383,
      sha256: "d480c146c08613f6fea8c0b647e5e099018d95915abfcc1c43d85d68291046a1",
      url: "https://github.com/sailfishos-sony-pdx246/main/releases/tag/v5.2.0.22-20261120",
    },
    {
      tag: "v5.2.0.22-20261101",
      file: "Sailfish_OS-5.2.0.22-pdx246-0.0.1.202611011745.zip",
      size: 881934459,
      sha256: "48baee0a5a7d8c54a8eca3854d5ad9bea1dd8caedb04781d28ca50dd11b5870d",
      url: "https://github.com/sailfishos-sony-pdx246/main/releases/tag/v5.2.0.22-20261101",
    },
  ],

  // LineageOS 23.2 release the Sailfish OS images are built for; its images are needed to
  // install again over Sailfish OS and to go back (INSTALL.md sections 4 and 5), and its OTA
  // zip to install from Sony's Android.
  lineage: {
    tag: "v23.2-20260924",
    url: "https://github.com/johanneszab/lineageos-pdx246-releases/releases/tag/v23.2-20260924",
    // LineageOS 23.2 is Android 16; an OTA zip of another Android version is refused.
    sdkLevel: "36",
    zips: [
      {
        tag: "v23.2-20260924",
        file: "lineage-23.2-20260924-UNOFFICIAL-pdx246.zip",
        size: 1394134959,
        sha256: "1808691f97a66ec959f0978002d86284980542a3628bcc8f6ba0f30400fe9eb4",
      },
    ],
    images: {
      "boot.img": { size: 100663296, sha256: "c9f9f9aeb15a89ee6827c377d595c99a3583f4a87c5cecd4c4572d2c2586c93f" },
      "vendor_boot.img": { size: 100663296, sha256: "e2bed09884588f46ac104e1217fa7fa73e8e17b6cb31b54f0a69e1a233408caf" },
      "dtbo.img": { size: 25165824, sha256: "6bfe5ecaea11cc107b5f0638294bb2d140ddf49d2d063f8a6252ce5e491acebc" },
      "vendor_dlkm.img": { size: 69554176, sha256: "1737d196093af5dd9b9d91defa3ef61f74cfc25062679693513aa362e185ec5e" },
      "recovery.img": { size: 104857600, sha256: "caf9215e86d0d324ee9fbade19e752671c01c9385d92e4d28d9ed80b97dab9f4" },
    },
  },

  // Installing from Sony's Android: LineageOS's OTA zip is written straight to slot a, the
  // way a build's images are flashed with fastboot (no recovery, no sideload).
  stock: {
    // The LineageOS release notes ask for Sony's firmware 70.2.A or newer; the bootloader
    // reports it as version-baseband ("70.2.A.4.22").
    minFirmware: [70, 2],
    // Sony's unlock code: 16 hexadecimal digits, which developer.sony.com gives for the IMEI.
    unlockCode: /^[0-9A-F]{16}$/,
    unlockCommand: (code) => `oem unlock 0x${code}`,
    // From the payload: these in the bootloader, ...
    physical: [
      ["boot", "boot_a"],
      ["vendor_boot", "vendor_boot_a"],
      ["dtbo", "dtbo_a"],
      ["recovery", "recovery_a"],
      ["vbmeta", "vbmeta_a"],
      ["vbmeta_system", "vbmeta_system_a"],
    ],
    // ... and the dynamic partitions in fastbootd, in this group, after the table of super
    // has been replaced by the build's empty one.
    group: "somc_dynamic_partitions",
    logical: ["system", "vendor", "vendor_dlkm", "system_ext", "odm", "product"],
    // The table as the pdx246 build writes it (BoardConfig.mk, build_super_image.py), checked
    // against the LineageOS build's own super.img.
    superLayout: {
      deviceSize: 17179869184,
      metadataMaxSize: 65536,
      metadataSlots: 3,
      blockSize: 4096,
      alignment: 1 * MiB,
      virtualAb: true,
    },
  },

  scripts: {
    "./flash-preflight.sh": preflight,
  },
};

export class PreflightError extends Error {
  constructor(title, advice) {
    super(title);
    this.name = "PreflightError";
    this.advice = advice;
  }
}

// flash-preflight.sh: from the bootloader, restart into fastbootd (the reply to that often
// gets lost, which is harmless), then check in fastbootd that it runs from slot a, that no
// Virtual A/B merge is pending, and that vendor_dlkm_a is a logical partition of slot a.
// Nothing is written before these checks pass.
export async function preflight(ctx, args) {
  if (args.includes("--reboot-fastboot")) {
    await ctx.rebootTo("fastboot", {
      slowAdvice:
        "If the phone shows the Sailfish OS start screen or its security code keypad instead of fastbootd, " +
        "its boot partition already holds Sailfish OS, and fastbootd cannot be reached that way. Nothing has " +
        "been written yet. Switch the phone off, start it in fastboot mode again, and choose “Install again” " +
        "above with the LineageOS images.",
    });
  }
  const fb = ctx.device("fastbootd");
  const check = async (name, want, title, advice) => {
    const v = await fb.tryGetVar(name);
    ctx.log(`   ${name}: ${v === null ? "(not supported)" : v}`);
    if (v !== want) throw new PreflightError(title.replace("%s", v === null ? "nothing" : `“${v}”`), advice);
  };
  await check(
    "is-userspace",
    "yes",
    "The phone is not in fastbootd.",
    "From the bootloader, the phone has to restart into the fastbootd screen of the LineageOS recovery.",
  );
  await check(
    "current-slot",
    "a",
    "fastbootd runs from slot %s, not slot a.",
    "Start again from the bootloader; this page makes slot a active first.",
  );
  await check(
    "snapshot-update-status",
    "none",
    "A system update of LineageOS is not finished (status %s).",
    "Restart the phone into LineageOS, wait at the home screen for a minute so that the update completes, " +
      "then switch it off and start again in fastboot mode.",
  );
  await check(
    "is-logical:vendor_dlkm_a",
    "yes",
    "vendor_dlkm_a is not a logical partition of slot a.",
    "Slot a does not hold a complete LineageOS 23.2 installation. Install LineageOS to slot a, start it once " +
      "to the home screen and wait a minute, then start again in fastboot mode.",
  );
  ctx.log("   pre-flight check passed: fastbootd on slot a, no pending merge, vendor_dlkm_a present");
}
preflight.title = "Restart into fastbootd and check the phone";
