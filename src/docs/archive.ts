/**
 * Minimal readers for the two archive formats PyPI serves: wheels (ZIP) and
 * sdists (.tar.gz). Only what is needed to pull text files out of a package:
 * no ZIP64, no encryption, no symlinks. Every entry is size-capped, so a
 * crafted archive cannot blow up memory. Contents are returned as data and
 * never executed.
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';

export interface ArchiveEntry {
  name: string;
  data: Buffer;
}

export interface ReadOptions {
  /** Called with each entry name; only matching entries are decompressed. */
  want: (name: string) => boolean;
  /** Entries larger than this (uncompressed) are skipped. */
  maxEntryBytes?: number;
  /** Stop after this many entries. */
  maxEntries?: number;
}

const DEFAULT_ENTRY_BYTES = 2_000_000;
const DEFAULT_ENTRIES = 5000;

// ------------------------------------------------------------ ZIP -----------

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

export function readZip(buf: Buffer, opts: ReadOptions): ArchiveEntry[] {
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_ENTRY_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_ENTRIES;
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment (<= 64 KiB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ArchiveEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !opts.want(name)) continue;
    // 0xffffffff means ZIP64 sizes; wheels that big are not worth reading.
    if (size > maxEntryBytes || compSize === 0xffffffff || local + 30 > buf.length) continue;
    if (buf.readUInt32LE(local) !== LOC) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    try {
      if (method === 0) out.push({ name, data: Buffer.from(raw.subarray(0, maxEntryBytes)) });
      else if (method === 8) out.push({ name, data: inflateRawSync(raw, { maxOutputLength: maxEntryBytes }) });
    } catch {
      // corrupt or over the cap: skip the entry
    }
    if (out.length >= maxEntries) break;
  }
  return out;
}

// ------------------------------------------------------------ tar.gz --------

function cString(buf: Buffer, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end >= 0 && end < start + len ? end : start + len);
}

/** Reads a gzip-compressed tar. `maxTotalBytes` caps the decompressed size. */
export function readTarGz(buf: Buffer, opts: ReadOptions & { maxTotalBytes?: number }): ArchiveEntry[] {
  const tar = gunzipSync(buf, { maxOutputLength: opts.maxTotalBytes ?? 200_000_000 });
  return readTar(tar, opts);
}

export function readTar(tar: Buffer, opts: ReadOptions): ArchiveEntry[] {
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_ENTRY_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_ENTRIES;
  const out: ArchiveEntry[] = [];
  let p = 0;
  let longName: string | undefined;
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(cString(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.toString('utf8', 257, 263).startsWith('ustar') ? cString(header, 345, 155) : '';
    let name = longName ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
    const dataStart = p + 512;
    const data = tar.subarray(dataStart, Math.min(dataStart + size, tar.length));
    p = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      // GNU long name: the next entry's name is this entry's data.
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      // PAX extended header: "<len> path=<name>\n" overrides the next name.
      const m = data.toString('utf8').match(/^\d+ path=(.*)$/m);
      if (m) longName = m[1];
      continue;
    }
    longName = undefined;
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    name = name.replace(/^\.\//, '');
    if (!opts.want(name) || size > maxEntryBytes) continue;
    out.push({ name, data: Buffer.from(data) });
    if (out.length >= maxEntries) break;
  }
  return out;
}
