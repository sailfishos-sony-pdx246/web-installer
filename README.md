<!--
SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Sailfish OS web installer for the Sony Xperia 10 VI

A web page that installs the Sailfish OS port for the Xperia 10 VI (pdx246) from the browser
over WebUSB, with no fastboot on the computer. It does what `flash.sh` in the image zip does,
and also the two procedures of INSTALL.md that are done by hand today: installing again over
Sailfish OS, and going back to LineageOS.

**Status: prototype.** Tested against a simulated phone (below) and once on a real phone: an
"Install again" run of release v5.2.0.22-20261101 with Google Chrome on Linux, 7 minutes from
start to finish. The read-only check also passed in Ubuntu's Chromium snap. The attention cues
and the parallel USB transfers came after that run and are tested in the simulation only. Not
yet tested on Windows or macOS.

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

### Xperia 10 VI specifics (`js/device-pdx246.js`)

- The Sony bootloader answers `getvar:max-download-size` with FAIL, so downloads are capped at
  256 MiB, the size `fastboot -S 256M` uses on this phone; in fastbootd the reported limit is
  used if it is smaller.
- The page writes only `boot_a`, `vendor_boot_a`, `dtbo_a`, `recovery_a`, `vendor_dlkm_a` and
  `userdata`.

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
are kept across page loads otherwise, as Chrome keeps them). `testzip=` and `testlineage=`
load files from the server instead of the file pickers.

On any page, `xfer=` (bytes per USB transfer) and `inflight=` (transfers in flight) change the
download settings for measurements, and `upload=1` sends the log to `tools/dev_server.py`
every few seconds.

### Tests

```sh
python3 tools/make_test_fixtures.py
```

Then open <http://localhost:8765/test/>: CRC-32, SHA-256, the zip reader (including ZIP64),
sparse splitting of synthetic images at many sizes, and the flash-config.sh parser. The
expected values come from Python (`tools/sparse_digest.py`). With `?upload=1` and
`tools/dev_server.py --upload-dir DIR`, the test page uploads the sparse pieces it produces;
`tools/check_pieces.py DIR test/fixtures` then checks them independently, and AOSP's
`simg2img` accepts each one.

For an end-to-end run with a real release, link the image zip and the LineageOS images into
`test/fixtures/` and compare what the simulated phone received
(`__mock.phone.results()`) with `tools/sparse_digest.py` run on the same files.

## Licences

Like the scripts of the port's main repository and the droid-hal-configs `flash.sh` this page
does the work of, the code is BSD-3-Clause; the documentation is CC-BY-SA-4.0. Each file says
which in its SPDX header; the texts are in `LICENSES/`.
