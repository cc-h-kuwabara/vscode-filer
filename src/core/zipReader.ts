import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { FileEntry, SortField, SortOrder } from './types';

export interface ZipEntryInfo {
  innerPath: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const EXACT_COLLATOR = new Intl.Collator(undefined);

const zipEntriesCache = new Map<string, { sig: string; entries: ZipEntryInfo[] }>();
const MAX_ARCHIVE_CACHE = 8;

function dosDateTimeToMs(dosDate: number, dosTime: number): number {
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = ((dosDate >> 5) & 0x0f) - 1;
  const day = dosDate & 0x1f;
  const hours = (dosTime >> 11) & 0x1f;
  const minutes = (dosTime >> 5) & 0x3f;
  const seconds = (dosTime & 0x1f) * 2;
  return new Date(year, Math.max(0, month), Math.max(1, day), hours, minutes, seconds).getTime();
}

function decodeZipFileName(bytes: Buffer, flags: number): string {
  const isUtf8 = (flags & 0x0800) !== 0;
  return bytes.toString(isUtf8 ? 'utf8' : 'utf8');
}

interface EocdInfo {
  totalEntries: number;
  cdSize: number;
  cdOffset: number;
}

function findEocd(tailBuf: Buffer): EocdInfo {
  for (let i = tailBuf.length - 22; i >= 0; i--) {
    if (tailBuf.readUInt32LE(i) === EOCD_SIGNATURE) {
      return {
        totalEntries: tailBuf.readUInt16LE(i + 10),
        cdSize: tailBuf.readUInt32LE(i + 12),
        cdOffset: tailBuf.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error('Invalid ZIP archive: End of Central Directory not found.');
}

function parseCentralDirectoryBuffer(
  cdBuf: Buffer,
  totalEntries: number
): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = [];
  let offset = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > cdBuf.length || cdBuf.readUInt32LE(offset) !== CD_SIGNATURE) {
      break;
    }

    const flags = cdBuf.readUInt16LE(offset + 8);
    const compressionMethod = cdBuf.readUInt16LE(offset + 10);
    const dosTime = cdBuf.readUInt16LE(offset + 12);
    const dosDate = cdBuf.readUInt16LE(offset + 14);
    const compressedSize = cdBuf.readUInt32LE(offset + 20);
    const uncompressedSize = cdBuf.readUInt32LE(offset + 24);
    const fileNameLen = cdBuf.readUInt16LE(offset + 28);
    const extraLen = cdBuf.readUInt16LE(offset + 30);
    const commentLen = cdBuf.readUInt16LE(offset + 32);
    const externalAttrs = cdBuf.readUInt32LE(offset + 38);
    const localHeaderOffset = cdBuf.readUInt32LE(offset + 42);

    const nameStart = offset + 46;
    const rawName = decodeZipFileName(cdBuf.subarray(nameStart, nameStart + fileNameLen), flags);
    const normalized = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
    const isDirFlag = normalized.endsWith('/') || (externalAttrs & 0x10) !== 0;
    const innerPath = normalized.replace(/\/+$/, '');

    if (innerPath) {
      entries.push({
        innerPath,
        isDirectory: isDirFlag,
        size: isDirFlag ? 0 : uncompressedSize,
        mtimeMs: dosDateTimeToMs(dosDate, dosTime),
        compressionMethod,
        compressedSize,
        localHeaderOffset,
      });
    }

    offset = nameStart + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

export function parseZipBuffer(buf: Buffer): ZipEntryInfo[] {
  const minOffset = Math.max(0, buf.length - 65557);
  const eocd = findEocd(buf.subarray(minOffset));
  return parseCentralDirectoryBuffer(
    buf.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize),
    eocd.totalEntries
  );
}

/**
 * Read only the ZIP End of Central Directory and Central Directory headers
 * without decompressing or reading file payloads.
 */
export async function readZipEntries(archivePath: string): Promise<ZipEntryInfo[]> {
  const handle = await fs.open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    const sig = `${stat.size}:${stat.mtimeMs}`;
    const cached = zipEntriesCache.get(archivePath);
    if (cached && cached.sig === sig) {
      return cached.entries;
    }

    const tailSize = Math.min(stat.size, 65557);
    const tailOffset = stat.size - tailSize;
    const tailBuf = Buffer.alloc(tailSize);
    await handle.read(tailBuf, 0, tailSize, tailOffset);

    const eocd = findEocd(tailBuf);
    const cdBuf = Buffer.alloc(eocd.cdSize);
    await handle.read(cdBuf, 0, eocd.cdSize, eocd.cdOffset);

    const entries = parseCentralDirectoryBuffer(cdBuf, eocd.totalEntries);
    if (zipEntriesCache.size >= MAX_ARCHIVE_CACHE) {
      const oldestKey = zipEntriesCache.keys().next().value;
      if (oldestKey) {
        zipEntriesCache.delete(oldestKey);
      }
    }
    zipEntriesCache.set(archivePath, { sig, entries });
    return entries;
  } finally {
    await handle.close();
  }
}

export function extractZipEntryFromBuffer(buf: Buffer, entry: ZipEntryInfo): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid local file header for: ${entry.innerPath}`);
  }

  const fileNameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLen + extraLen;
  const compressedData = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressedData);
  }
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(compressedData);
  }
  throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) for: ${entry.innerPath}`);
}

export async function extractZipEntryToTempFile(
  archivePath: string,
  innerPath: string
): Promise<string> {
  const entries = await readZipEntries(archivePath);
  const target = entries.find((e) => !e.isDirectory && e.innerPath === innerPath);
  if (!target) {
    throw new Error(`Entry not found in ZIP: ${innerPath}`);
  }

  let content: Buffer;
  const handle = await fs.open(archivePath, 'r');
  try {
    const headerBuf = Buffer.alloc(30);
    await handle.read(headerBuf, 0, 30, target.localHeaderOffset);
    if (headerBuf.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`Invalid local file header for: ${target.innerPath}`);
    }
    const fileNameLen = headerBuf.readUInt16LE(26);
    const extraLen = headerBuf.readUInt16LE(28);
    const dataStart = target.localHeaderOffset + 30 + fileNameLen + extraLen;
    const compressedData = Buffer.alloc(target.compressedSize);
    await handle.read(compressedData, 0, target.compressedSize, dataStart);

    if (target.compressionMethod === 0) {
      content = compressedData;
    } else if (target.compressionMethod === 8) {
      content = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(
        `Unsupported ZIP compression method (${target.compressionMethod}) for: ${target.innerPath}`
      );
    }
  } finally {
    await handle.close();
  }

  const tempRoot = path.join(os.tmpdir(), 'vscode-filer-zip');
  const safeRel = innerPath.split('/').filter((seg) => seg && seg !== '..').join(path.sep);
  const outPath = path.join(tempRoot, path.basename(archivePath), safeRel);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, content);
  return outPath;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function sortFileEntries(entries: FileEntry[], field: SortField, order: SortOrder): void {
  if (entries.length <= 1) {
    return;
  }
  const dirFactor = order === 'asc' ? 1 : -1;
  let extCache: Map<FileEntry, string> | null = null;
  if (field === 'ext') {
    extCache = new Map();
    for (const entry of entries) {
      extCache.set(entry, path.extname(entry.name).toLowerCase());
    }
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    let cmp = 0;
    switch (field) {
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'mtime':
        cmp = a.mtimeMs - b.mtimeMs;
        break;
      case 'ext': {
        const extA = extCache!.get(a) ?? '';
        const extB = extCache!.get(b) ?? '';
        cmp = NAME_COLLATOR.compare(extA, extB);
        break;
      }
      case 'name':
      default:
        cmp = NAME_COLLATOR.compare(a.name, b.name);
        break;
    }
    if (cmp === 0) {
      cmp = EXACT_COLLATOR.compare(a.name, b.name);
    }
    return cmp * dirFactor;
  });
}

export async function listZipDirectory(
  archivePath: string,
  innerDir: string,
  options: {
    showDotFiles: boolean;
    sortField: SortField;
    sortOrder: SortOrder;
    mask?: string;
  }
): Promise<FileEntry[]> {
  const allEntries = await readZipEntries(archivePath);
  const prefix = innerDir ? `${innerDir.replace(/^\/+|\/+$/g, '')}/` : '';
  const childMap = new Map<string, FileEntry>();
  const maskRegex = options.mask?.trim() ? globToRegExp(options.mask.trim()) : null;

  for (const item of allEntries) {
    if (prefix && !item.innerPath.startsWith(prefix)) {
      continue;
    }
    const rel = prefix ? item.innerPath.slice(prefix.length) : item.innerPath;
    if (!rel) {
      continue;
    }

    const slashIdx = rel.indexOf('/');
    const childName = slashIdx >= 0 ? rel.slice(0, slashIdx) : rel;
    if (!childName) {
      continue;
    }
    if (!options.showDotFiles && childName.startsWith('.')) {
      continue;
    }

    const isChildDir = slashIdx >= 0 || item.isDirectory;
    if (maskRegex && !isChildDir && !maskRegex.test(childName)) {
      continue;
    }

    const childInnerPath = prefix ? `${prefix}${childName}` : childName;
    const existing = childMap.get(childName);
    if (!existing) {
      childMap.set(childName, {
        name: childName,
        path: `${archivePath}::${childInnerPath}`,
        isDirectory: isChildDir,
        isSymlink: false,
        size: isChildDir ? 0 : item.size,
        mtimeMs: item.mtimeMs,
        mode: isChildDir ? 0o755 : 0o644,
        marked: false,
      });
    } else if (isChildDir && !existing.isDirectory) {
      existing.isDirectory = true;
      existing.size = 0;
      existing.mode = 0o755;
    }
  }

  const children = Array.from(childMap.values());
  sortFileEntries(children, options.sortField, options.sortOrder);

  const upEntry: FileEntry = {
    name: '..',
    path: archivePath,
    isDirectory: true,
    isSymlink: false,
    size: 0,
    mtimeMs: 0,
    mode: 0o755,
    marked: false,
  };

  return [upEntry, ...children];
}
