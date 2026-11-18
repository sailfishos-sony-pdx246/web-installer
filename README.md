<!--
SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Sailfish OS web installer for the Sony Xperia 10 VI

A web page that installs the Sailfish OS port for the Xperia 10 VI (pdx246) from the browser
over WebUSB, with no fastboot on the computer. It does what `flash.sh` in the image zip does,
and also the procedures of INSTALL.md that are done by hand today: installing LineageOS 23.2
on a phone that runs Sony's Android, installing again over Sailfish OS, and going back to
LineageOS.

**Status: prototype.** Tested against a simulated phone (below) and on a real phone with
Google Chrome on Linux:
- "Install again" of release v5.2.0.22-20261101: 7 minutes from start to finish, with one USB
  transfer at a time.
- "Install Sailfish OS from Sony's Android" on that phone while it ran Sailfish OS: LineageOS
  v23.2-20260924 written from its OTA zip, then Sailfish OS, in 8 minutes, with downloads at
  about 25 MB/s through a virtual machine.

The read-only check also passed in Ubuntu's Chromium snap. Not yet tested on a real phone: the
parts only a phone with Sony's Android has (the unlock, Sony's own partitions in super, slot b),
and the attention cues (no click was needed). Not yet tested on Windows or macOS.

## How it works

- **Files.** The user picks the image zip as downloaded; the page reads it in place, without
  unpacking it. It identifies the release by its SHA-256 and checks the CRC-32 of every image
  it will write before the phone is touched. The LineageOS images are checked against the
  SHA-256 sums of their release.
- **Operations.** The page reads `flash-config.sh` from the zip and runs its `FLASH_OPS`
  with flash.sh's semantics: `getvar_fail_if` before anything changes, `flash`,
  `flash_dont_fail` (30 retries), `run fastboot --set-active=…`, `run fastboot reboot …`,
  `run sleep`. `run ./flash-preflight.sh` is done by an equivalent built into the device
  profile. Anything else, or a partition outside the profile's list, stops the installation
  before the first command.
- **fastboot.** Its own implementation over WebUSB, following AOSP's host side
  (`system/core/fastboot`): the same commands, logical partitions resized to the image size
  before writing, and images larger than one download split into sparse pieces the way
  libsparse's `sparse_file_resparse()` does. Images are streamed from the zip, so only one
  piece (at most 256 MiB) is in memory at a time. Downloads keep four 256 KiB USB transfers in
  flight, and the log shows the speed of each.
- **Restarts.** The browser sees the bootloader (0fce:0dde) and fastbootd (18d1:4ee0) as two
  devices, and lets a page open a device only after the user picked it once in the device list.
  Chrome keeps that permission for the site, so only the first fastbootd restart in a browser
  needs a click; later the page finds the phone by itself. For that click the page plays a
  chime, flashes the tab title and puts the focus on Connect; it does so at once for an
  identity this browser has not allowed before (remembered in localStorage), and after a minute
  for a known one. Other chimes mark the end and an error; a checkbox turns the sound off. A
  lost answer to `reboot-fastboot`, common with this bootloader, is not an error.

### From Sony's Android (`js/stock.js`, `js/payload.js`)

LineageOS is written straight to slot a from its OTA zip, the way a build's images are
flashed with fastboot, instead of LineageOS's usual way through its recovery and
`adb sideload`. So no recovery menus, no adb, no second slot and no first start of LineageOS
are needed: without an update applied by the phone, there is no Virtual A/B merge to wait for.

- **The zip.** The page reads `payload.bin` in place (format "CrAU", AOSP's
  `update_metadata.proto`): a full payload holds each partition as operations on 4 KiB blocks,
  REPLACE, REPLACE_XZ, REPLACE_BZ and ZERO, with a SHA-256 for every operation's data and every
  partition. Before the phone is touched, it identifies the release by its SHA-256, refuses a
  zip for another device or another Android version (LineageOS 24 is Android 17), and unpacks
  every partition once against its checksum: 6.1 GB, a few minutes. Its own XZ (`js/xz.js`) and
  bzip2 (`js/bzip2.js`) decompressors do the unpacking; blocks that repeat one 4-byte value,
  such as the zeros of a partition's free space, become FILL chunks of the sparse pieces and
  cost no transfer time.
- **The phone.** In the bootloader, the page reads `getvar:all` (where Sony's bootloader also
  reports the active slot) and checks the model and Sony's firmware: LineageOS 23.2 needs 70.2
  or newer. It unlocks the bootloader with `oem unlock 0x<code>` and Sony's code, typed into the
  page, if it is locked. LineageOS and Sailfish OS run from slot a; if Sony's Android ran from
  slot b, the page restarts into slot a's bootloader to check the firmware there too, and stops
  if it is older (it would have to be copied over first, which the page cannot do).
- **Writing.** In the bootloader: LineageOS's boot, vendor_boot, dtbo, recovery, vbmeta and
  vbmeta_system to slot a, slot a active. Then the page restarts into LineageOS's fastbootd,
  cancels an update of Sony's Android that may be pending, replaces the table of the super
  partition with the build's empty one (`update-super`, built by `js/lp-metadata.js` as lpmake
  does) and writes system, vendor, vendor_dlkm, system_ext, odm and product. The Sailfish OS
  installation follows as usual. Every run starts over from the boot images, so a stopped one
  can simply be started again.

What the page assumes about Sony's bootloader on a phone with Sony's Android, from the
LineageOS port, AOSP's fastboot and Sony's instructions, without having seen it: `getvar:all`
lists `current-slot`; a locked bootloader refuses to write and to switch slots; `oem unlock
0x<code>` answers OKAY (the page also copes with a restart afterwards); `version-baseband`
reports the firmware of the active slot.

### Xperia 10 VI specifics (`js/device-pdx246.js`)

- The Sony bootloader answers `getvar:max-download-size` with FAIL, so downloads are capped at
  256 MiB, the size `fastboot -S 256M` uses on this phone; in fastbootd the reported limit is
  used if it is smaller.
- From a Sailfish OS zip's `FLASH_OPS`, the page writes only `boot_a`, `vendor_boot_a`,
  `dtbo_a`, `recovery_a`, `vendor_dlkm_a` and `userdata`. From LineageOS's zip, it also writes
  `vbmeta_a`, `vbmeta_system_a` and the dynamic partitions of slot a.
- The table of super: 16 GiB, the group `somc_dynamic_partitions` in both slots, Virtual A/B
  (metadata version 10.2, three slots), the same bytes as the table of the LineageOS build's own
  super.img without its extents.

### Differences from flash.sh and host fastboot

- `md5.lst` is not used: the SHA-256 of the zip and the CRC-32 of every image cover it.
- Images are written as they are, like `flash:raw`. Host fastboot would move an AVB footer to
  the end of a larger partition, but on this phone it skips that, because the bootloader does
  not report partition sizes.
- `is-logical:` and `max-download-size` are queried only in fastbootd, as the bootloader
  garbles long variable names.

## Browsers and computers

Chromium-based browsers (Chrome, Chromium, Edge, Brave) on Linux, macOS, Windows and ChromeOS;
WebUSB needs the page on https or on localhost. On Linux, systemd 258 and newer give the
logged-in user access to fastboot devices; older systems need a udev rule for the two USB IDs.
Windows needs a WinUSB driver for the bootloader's fastboot mode (see the page).

`?readonly=1` turns the page into a read-only check: after Connect it reads the variables
flash.sh reads first (in fastbootd, those of the pre-flight check), shows them, and lets go of
the phone. The fastboot layer then refuses every command except `getvar`, before anything is
sent.

## Running it locally

```sh
python3 tools/dev_server.py --port 8765
```

Then open <http://localhost:8765/>. `tools/dev_server.py` serves the page without caching and,
for the tests, supports byte ranges and uploads.

### Simulation

`http://localhost:8765/?mock=1` replaces WebUSB with a simulated phone (`js/mock-usb.js`): the
same USB IDs, the bootloader's FAIL for long variable names, the lost answer to
`reboot-fastboot`, and a record of what is written. Parameters: `bootA=sailfish` (boot_a holds
Sailfish OS, so fastbootd is not reachable), `merge=merging` (a pending Virtual A/B merge),
`lostReply=0`, `scale=` (time factor of the phone's delays), `usbLatency=` (milliseconds per
USB transfer), `mockReset=1` (forget the simulated USB permissions, like a new browser; they
are kept across page loads otherwise, as Chrome keeps them). `testzip=`, `testlineage=` and
`testlineagezip=` load files from the server instead of the file pickers.

`stock=1` simulates a phone with Sony's Android: a locked bootloader (`unlocked=1` for an
unlocked one) whose unlock code is `0123456789ABCDEF` (`unlockCode=` for another), Sony's
partitions in super and Sony's recovery. Further parameters: `stockSlot=a|b` (the active slot,
b by default), `fwA=`, `fwB=` (each slot's firmware, `70.2.A.4.22` by default), `oemUnlock=off`
(OEM unlocking switched off), `unlockReboots=1` (the bootloader restarts after unlocking),
`fastbootdMax=` (fastbootd's download limit, for many small pieces) and `lineageBoot=` (the
SHA-256 of a test zip's boot image, so that the simulation takes it for LineageOS's).

On any page, `xfer=` (bytes per USB transfer) and `inflight=` (transfers in flight) change the
download settings for measurements, and `upload=1` sends the log to `tools/dev_server.py`
every few seconds.

### Tests

```sh
python3 tools/make_test_fixtures.py
```

Then open <http://localhost:8765/test/>: CRC-32, SHA-256, the zip reader (including ZIP64),
sparse splitting of synthetic images at many sizes, the flash-config.sh parser, the XZ and
bzip2 decompressors (data from Python's `lzma` and `bz2` and the `xz` tool in many variants,
and damaged copies), the super partition's table (against `tools/lp_metadata.py`, a second
implementation in Python), and the payload reader (synthetic payloads with every operation
type, unpacked as a stream and as sparse pieces of several sizes). The expected values come
from Python (`tools/sparse_digest.py`). With `?upload=1` and `tools/dev_server.py --upload-dir
DIR`, the test page uploads the sparse pieces it produces; `tools/check_pieces.py DIR
test/fixtures` then checks them independently, and AOSP's `simg2img` accepts each one.

For an end-to-end run with a real release, link the image zip and the LineageOS images into
`test/fixtures/` and compare what the simulated phone received
(`__mock.phone.results()`) with `tools/sparse_digest.py` run on the same files. For the
installation from Sony's Android, link the LineageOS release's folder (with its OTA zip and
super.img) as `test/fixtures/real-lineage/`: `make_test_fixtures.py` then also compares the
super table, `/test/?only=realota` unpacks the whole zip in the browser, and
`tools/payload_digest.py` gives the values the simulated phone has to report, unpacked with
Python's own `lzma` and `bz2`.

## Licences

Like the scripts of the port's main repository and the droid-hal-configs `flash.sh` this page
does the work of, the code is BSD-3-Clause; the documentation is CC-BY-SA-4.0. Each file says
which in its SPDX header; the texts are in `LICENSES/`.
