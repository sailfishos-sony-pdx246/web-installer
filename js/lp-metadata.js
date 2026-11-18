// SPDX-FileCopyrightText: Johannes Meyer zum Alten Borgloh
// SPDX-License-Identifier: BSD-3-Clause
//
// The partition table of the super partition, "LP metadata" (system/core/fs_mgr/liblp):
// building the empty table that fastbootd's "update-super" takes (what the build writes as
// super_empty.img), and reading one back with the checks liblp makes. The layout rules are
// those of MetadataBuilder and lpmake, as build_super_image.py calls it.

import { Sha256 } from "./sha256.js";

export const LP_SECTOR = 512;
const GEOMETRY_MAGIC = 0x616c4467;
const GEOMETRY_SIZE = 4096;
const GEOMETRY_STRUCT = 52;
const HEADER_MAGIC = 0x414c5030;
const MAJOR = 10;
const HEADER_V1_0 = 128;
const HEADER_V1_2 = 256;
const RESERVED = 4096;
const PARTITION_ENTRY = 52;
const EXTENT_ENTRY = 24;
const GROUP_ENTRY = 48;
const BLOCK_DEVICE_ENTRY = 64;
export const LP_ATTR_READONLY = 1;
export const LP_ATTR_SLOT_SUFFIXED = 2;
export const LP_ATTR_UPDATED = 4;
export const LP_ATTR_DISABLED = 8;
export const LP_HEADER_FLAG_VIRTUAL_AB = 1;

export class LpError extends Error {
  constructor(message) {
    super(message);
    this.name = "LpError";
  }
}

const alignUp = (v, a) => Math.ceil(v / a) * a;
const sha256 = (u8) => new Sha256().update(u8).digest();

// Geometry block, both metadata copies of every slot: what precedes the first partition.
export function totalMetadataSize(metadataMaxSize, slots) {
  return RESERVED + (GEOMETRY_SIZE + metadataMaxSize * slots) * 2;
}

function putName(u8, off, name) {
  if (!/^[\x21-\x7e]{1,36}$/.test(name)) throw new LpError(`invalid name in the partition table: ${JSON.stringify(name)}`);
  for (let i = 0; i < name.length; i++) u8[off + i] = name.charCodeAt(i);
}

function getName(u8, off) {
  let s = "";
  for (let i = 0; i < 36 && u8[off + i]; i++) s += String.fromCharCode(u8[off + i]);
  return s;
}

function putU64(v, off, n) {
  v.setUint32(off, n % 0x100000000, true);
  v.setUint32(off + 4, Math.floor(n / 0x100000000), true);
}

function getU64(v, off) {
  return v.getUint32(off, true) + v.getUint32(off + 4, true) * 0x100000000;
}

// The empty table for a layout:
//   { deviceSize, superName = "super", metadataMaxSize = 65536, metadataSlots = 3,
//     blockSize = 4096, alignment = 1 MiB, alignmentOffset = 0, virtualAb = false,
//     groups: [{ name, maxSize }], partitions: [{ name, group, attributes = 0 }] }
// The "default" group comes first, as in every table liblp builds.
export function buildSuperEmpty(layout) {
  const {
    deviceSize,
    superName = "super",
    metadataSlots = 3,
    blockSize = 4096,
    alignment = 1 << 20,
    alignmentOffset = 0,
    virtualAb = false,
    groups = [],
    partitions = [],
  } = layout;
  const metadataMaxSize = alignUp(layout.metadataMaxSize ?? 65536, LP_SECTOR);
  if (metadataMaxSize < HEADER_V1_2 || metadataSlots < 1) throw new LpError("invalid metadata size or slot count");
  const firstLogical = alignUp(totalMetadataSize(metadataMaxSize, metadataSlots), alignment || blockSize) / LP_SECTOR;
  if (!(deviceSize >= firstLogical * LP_SECTOR + blockSize)) throw new LpError("the super partition is too small for its metadata");

  const allGroups = [{ name: "default", maxSize: 0 }, ...groups];
  const groupIndex = new Map(allGroups.map((g, i) => [g.name, i]));
  if (groupIndex.size !== allGroups.length) throw new LpError("duplicate group name");
  if (new Set(partitions.map((p) => p.name)).size !== partitions.length) throw new LpError("duplicate partition name");

  // MetadataBuilder: the Virtual A/B flag needs the expanded header (version 10.2); the
  // UPDATED and DISABLED attributes need at least version 10.1.
  let minor = 0;
  for (const p of partitions) if ((p.attributes || 0) & (LP_ATTR_UPDATED | LP_ATTR_DISABLED)) minor = 1;
  const headerSize = virtualAb ? HEADER_V1_2 : HEADER_V1_0;
  if (virtualAb) minor = 2;

  const pSize = partitions.length * PARTITION_ENTRY;
  const gSize = allGroups.length * GROUP_ENTRY;
  const tables = new Uint8Array(pSize + gSize + BLOCK_DEVICE_ENTRY);
  const tv = new DataView(tables.buffer);
  partitions.forEach((p, i) => {
    const off = i * PARTITION_ENTRY;
    putName(tables, off, p.name);
    if (!groupIndex.has(p.group)) throw new LpError(`partition ${p.name} is in an unknown group`);
    tv.setUint32(off + 36, p.attributes || 0, true);
    tv.setUint32(off + 40, 0, true); // first_extent_index: there are no extents
    tv.setUint32(off + 44, 0, true); // num_extents
    tv.setUint32(off + 48, groupIndex.get(p.group), true);
  });
  allGroups.forEach((g, i) => {
    const off = pSize + i * GROUP_ENTRY;
    putName(tables, off, g.name);
    tv.setUint32(off + 36, 0, true);
    putU64(tv, off + 40, g.maxSize);
  });
  const b = pSize + gSize;
  putU64(tv, b, firstLogical);
  tv.setUint32(b + 8, alignment, true);
  tv.setUint32(b + 12, alignmentOffset, true);
  putU64(tv, b + 16, deviceSize);
  putName(tables, b + 24, superName);
  tv.setUint32(b + 60, 0, true);

  const header = new Uint8Array(headerSize);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, HEADER_MAGIC, true);
  hv.setUint16(4, MAJOR, true);
  hv.setUint16(6, minor, true);
  hv.setUint32(8, headerSize, true);
  hv.setUint32(44, tables.length, true);
  header.set(sha256(tables), 48);
  const desc = [
    [0, partitions.length, PARTITION_ENTRY],
    [pSize, 0, EXTENT_ENTRY],
    [pSize, allGroups.length, GROUP_ENTRY],
    [pSize + gSize, 1, BLOCK_DEVICE_ENTRY],
  ];
  desc.forEach(([off, n, size], i) => {
    hv.setUint32(80 + i * 12, off, true);
    hv.setUint32(84 + i * 12, n, true);
    hv.setUint32(88 + i * 12, size, true);
  });
  if (virtualAb) hv.setUint32(128, LP_HEADER_FLAG_VIRTUAL_AB, true);
  header.set(sha256(header), 12); // computed with the checksum field still zero
  if (headerSize + tables.length > metadataMaxSize) throw new LpError("the partition table is larger than its maximum size");

  const out = new Uint8Array(GEOMETRY_SIZE + headerSize + tables.length);
  const gv = new DataView(out.buffer);
  gv.setUint32(0, GEOMETRY_MAGIC, true);
  gv.setUint32(4, GEOMETRY_STRUCT, true);
  gv.setUint32(40, metadataMaxSize, true);
  gv.setUint32(44, metadataSlots, true);
  gv.setUint32(48, blockSize, true);
  out.set(sha256(out.subarray(0, GEOMETRY_STRUCT)), 8);
  out.set(header, GEOMETRY_SIZE);
  out.set(tables, GEOMETRY_SIZE + headerSize);
  return out;
}

// Reads a table image (geometry, then metadata) with liblp's checks (ReadFromImageBlob:
// ParseGeometry, ReadMetadataHeader, ParseMetadata). Throws LpError naming the problem.
export function parseSuperImage(bytes) {
  if (bytes.length < GEOMETRY_SIZE) throw new LpError("smaller than the geometry block");
  const gv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (gv.getUint32(0, true) !== GEOMETRY_MAGIC) throw new LpError("invalid geometry magic");
  const structSize = gv.getUint32(4, true);
  if (structSize > GEOMETRY_STRUCT) throw new LpError("geometry has unrecognized fields");
  const g = bytes.slice(0, structSize);
  g.fill(0, 8, 40);
  const want = sha256(g);
  for (let i = 0; i < 32; i++) if (bytes[8 + i] !== want[i]) throw new LpError("invalid geometry checksum");
  if (structSize !== GEOMETRY_STRUCT) throw new LpError("invalid geometry struct size");
  const geometry = {
    metadataMaxSize: gv.getUint32(40, true),
    metadataSlots: gv.getUint32(44, true),
    blockSize: gv.getUint32(48, true),
  };
  if (geometry.metadataSlots === 0) throw new LpError("invalid slot count");
  if (geometry.metadataMaxSize % LP_SECTOR) throw new LpError("metadata max size not sector-aligned");

  const m = bytes.subarray(GEOMETRY_SIZE);
  if (m.length < HEADER_V1_0) throw new LpError("metadata header truncated");
  const mv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  if (mv.getUint32(0, true) !== HEADER_MAGIC) throw new LpError("invalid metadata magic");
  const major = mv.getUint16(4, true);
  const minor = mv.getUint16(6, true);
  if (major !== MAJOR || minor > 2) throw new LpError(`incompatible metadata version ${major}.${minor}`);
  const headerSize = mv.getUint32(8, true);
  if (headerSize !== (minor < 2 ? HEADER_V1_0 : HEADER_V1_2)) throw new LpError("invalid header size");
  if (m.length < headerSize) throw new LpError("metadata header truncated");
  const h = m.slice(0, headerSize);
  h.fill(0, 12, 44);
  const hsum = sha256(h);
  for (let i = 0; i < 32; i++) if (m[12 + i] !== hsum[i]) throw new LpError("invalid header checksum");
  const tablesSize = mv.getUint32(44, true);
  const desc = [0, 1, 2, 3].map((i) => ({
    offset: mv.getUint32(80 + i * 12, true),
    count: mv.getUint32(84 + i * 12, true),
    size: mv.getUint32(88 + i * 12, true),
  }));
  for (const d of desc) {
    if (d.offset > tablesSize || tablesSize - d.offset < d.count * d.size) throw new LpError("invalid table bounds");
  }
  if (desc[0].size !== PARTITION_ENTRY || desc[1].size !== EXTENT_ENTRY || desc[2].size !== GROUP_ENTRY) {
    throw new LpError("invalid table entry size");
  }
  const flags = headerSize >= 132 ? mv.getUint32(128, true) : 0;
  if (tablesSize > geometry.metadataMaxSize) throw new LpError("invalid table size");
  if (m.length < headerSize + tablesSize) throw new LpError("tables truncated");
  const t = m.subarray(headerSize, headerSize + tablesSize);
  const tsum = sha256(t);
  for (let i = 0; i < 32; i++) if (m[48 + i] !== tsum[i]) throw new LpError("invalid table checksum");
  const tv = new DataView(t.buffer, t.byteOffset, t.byteLength);

  const validAttrs = LP_ATTR_READONLY | LP_ATTR_SLOT_SUFFIXED | (minor >= 1 ? LP_ATTR_UPDATED | LP_ATTR_DISABLED : 0);
  const groups = [];
  for (let i = 0; i < desc[2].count; i++) {
    const o = desc[2].offset + i * desc[2].size;
    groups.push({ name: getName(t, o), flags: tv.getUint32(o + 36, true), maxSize: getU64(tv, o + 40) });
  }
  const blockDevices = [];
  for (let i = 0; i < desc[3].count; i++) {
    const o = desc[3].offset + i * desc[3].size;
    blockDevices.push({
      firstLogicalSector: getU64(tv, o),
      alignment: tv.getUint32(o + 8, true),
      alignmentOffset: tv.getUint32(o + 12, true),
      size: getU64(tv, o + 16),
      name: getName(t, o + 24),
      flags: tv.getUint32(o + 60, true),
    });
  }
  const extents = [];
  for (let i = 0; i < desc[1].count; i++) {
    const o = desc[1].offset + i * desc[1].size;
    const e = { sectors: getU64(tv, o), type: tv.getUint32(o + 8, true), data: getU64(tv, o + 12), source: tv.getUint32(o + 20, true) };
    if (e.type === 0 && e.source >= blockDevices.length) throw new LpError("extent on an invalid block device");
    extents.push(e);
  }
  const partitions = [];
  for (let i = 0; i < desc[0].count; i++) {
    const o = desc[0].offset + i * desc[0].size;
    const p = {
      name: getName(t, o),
      attributes: tv.getUint32(o + 36, true),
      firstExtent: tv.getUint32(o + 40, true),
      extents: tv.getUint32(o + 44, true),
      groupIndex: tv.getUint32(o + 48, true),
    };
    if (p.attributes & ~validAttrs) throw new LpError("partition has invalid attributes");
    if (p.firstExtent + p.extents > extents.length) throw new LpError("partition has an invalid extent list");
    if (p.groupIndex >= groups.length) throw new LpError("partition has an invalid group");
    p.group = groups[p.groupIndex].name;
    p.size = 0;
    for (let k = p.firstExtent; k < p.firstExtent + p.extents; k++) p.size += extents[k].sectors * LP_SECTOR;
    partitions.push(p);
  }
  if (!blockDevices.length) throw new LpError("no super block device");
  const reserved = totalMetadataSize(geometry.metadataMaxSize, geometry.metadataSlots);
  if (reserved > blockDevices[0].firstLogicalSector * LP_SECTOR) {
    throw new LpError("metadata overlaps with the partitions");
  }
  return { geometry, version: `${major}.${minor}`, headerSize, flags, partitions, extents, groups, blockDevices };
}
