// Minimal ZIP support for project export/import, without dependencies.
// Writes stored (uncompressed) entries; reads stored and deflated entries.
// No ZIP64: archives and entries must stay under 4 GB.
import { crc32, inflateRawSync } from 'node:zlib';

const MAX = 0xffffffff;
function fail(message) { const e = Error(message); e.status = 400; throw e; }

export function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(p => !p || p === '.' || p === '..')) fail(`Unsafe archive path: ${String(name).slice(0, 80)}`);
  return name;
}

// entries: [{ name, data: Buffer }]
export function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const date = new Date(), dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  for (const { name, data } of entries) {
    safeEntryName(name);
    if (data.length >= MAX || offset >= MAX) fail('Project is too large to export (4 GB limit)');
    const nameBytes = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 30); central.writeUInt32LE(0, 34); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// Returns Map(name → Buffer). Rejects unsafe paths, duplicates, encryption and oversize content.
export function readZip(buffer, { maxEntries = 10000, maxTotal = 2 * 1024 ** 3 } = {}) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('Not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10), size = buffer.readUInt32LE(eocd + 12), start = buffer.readUInt32LE(eocd + 16);
  if (count > maxEntries || start + size > buffer.length) fail('Archive directory is invalid or too large');
  const out = new Map();
  let p = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) fail('Archive directory is corrupt');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10), crc = buffer.readUInt32LE(p + 16);
    const compressed = buffer.readUInt32LE(p + 20), length = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32), localAt = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    safeEntryName(name);
    if (flags & 1) fail('Encrypted archives are not supported');
    if (out.has(name)) fail(`Duplicate archive entry ${name}`);
    total += length; if (total > maxTotal) fail('Archive content is too large');
    if (buffer.readUInt32LE(localAt) !== 0x04034b50) fail('Archive entry is corrupt');
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = buffer.subarray(dataAt, dataAt + compressed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: length + 1 });
    else fail(`Unsupported compression in ${name}`);
    if (data.length !== length || crc32(data) !== crc) fail(`Checksum mismatch in ${name}`);
    out.set(name, data);
  }
  return out;
}

/** Entry names from the central directory only (nothing is decompressed); [] when this is not a ZIP archive. */
export function zipEntryNames(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const count = buffer.readUInt16LE(eocd + 10), start = buffer.readUInt32LE(eocd + 16), names = [];
  for (let i = 0, p = start; i < count && p + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) return names;
    const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
    names.push(buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
