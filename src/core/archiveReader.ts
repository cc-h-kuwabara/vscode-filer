import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { FileEntry, SortField, SortOrder } from './types';
import {
  extractZipEntryToTempFile,
  readZipEntries,
  sortFileEntries,
} from './zipReader';

export type ArchiveKind = 'zip' | 'tar' | 'tar.gz';

export interface ArchiveEntryInfo {
  innerPath: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  dataOffset?: number;
}

export function getArchiveKind(fileName: string): ArchiveKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) {
    return 'zip';
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return 'tar.gz';
  }
  if (lower.endsWith('.tar')) {
    return 'tar';
  }
  return null;
}

export function isSupportedArchive(fileName: string): boolean {
  return getArchiveKind(fileName) !== null;
}

function readNullTerminatedString(buf: Buffer, start: number, end: number): string {
  let actualEnd = start;
  while (actualEnd < end && buf[actualEnd] !== 0) {
    actualEnd++;
  }
  return buf.subarray(start, actualEnd).toString('utf8');
}

function parseOctal(buf: Buffer, start: number, end: number): number {
  const raw = readNullTerminatedString(buf, start, end).trim();
  if (!raw) {
    return 0;
  }
  const parsed = parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(buf: Buffer, offset = 0): boolean {
  for (let i = 0; i < 512; i++) {
    if (buf[offset + i] !== 0) {
      return false;
    }
  }
  return true;
}

function parsePaxPath(paxData: Buffer): string | null {
  const text = paxData.toString('utf8');
  for (const line of text.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) {
      continue;
    }
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx < 0 || spaceIdx > eqIdx) {
      continue;
    }
    const key = line.slice(spaceIdx + 1, eqIdx);
    if (key === 'path') {
      return line.slice(eqIdx + 1);
    }
  }
  return null;
}

export function parseTarBuffer(buf: Buffer): ArchiveEntryInfo[] {
  const entries: ArchiveEntryInfo[] = [];
  let offset = 0;
  let nextLongName: string | null = null;

  while (offset + 512 <= buf.length) {
    if (isZeroBlock(buf, offset)) {
      break;
    }

    const namePart = readNullTerminatedString(buf, offset, offset + 100);
    const size = parseOctal(buf, offset + 124, offset + 136);
    const mtimeSec = parseOctal(buf, offset + 136, offset + 148);
    const typeFlag = String.fromCharCode(buf[offset + 156]);
    const prefixPart = readNullTerminatedString(buf, offset + 345, offset + 500);

    const dataStart = offset + 512;
    const paddedDataSize = Math.ceil(size / 512) * 512;

    if (typeFlag === 'L') {
      // GNU tar long filename
      nextLongName = readNullTerminatedString(buf, dataStart, Math.min(buf.length, dataStart + size));
      offset = dataStart + paddedDataSize;
      continue;
    }

    if (typeFlag === 'x') {
      // PAX extended header for next file
      const paxSlice = buf.subarray(dataStart, Math.min(buf.length, dataStart + size));
      const paxPath = parsePaxPath(paxSlice);
      if (paxPath) {
        nextLongName = paxPath;
      }
      offset = dataStart + paddedDataSize;
      continue;
    }

    if (typeFlag === 'g') {
      // Global PAX header
      offset = dataStart + paddedDataSize;
      continue;
    }

    const rawName = nextLongName ?? (prefixPart ? `${prefixPart}/${namePart}` : namePart);
    nextLongName = null;

    const normalized = rawName.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const isDir = typeFlag === '5' || normalized.endsWith('/');
    const innerPath = normalized.replace(/\/+$/, '');

    if (innerPath && (typeFlag === '0' || typeFlag === '\0' || typeFlag === '5' || typeFlag === '2')) {
      entries.push({
        innerPath,
        isDirectory: isDir,
        size: isDir ? 0 : size,
        mtimeMs: mtimeSec * 1000,
        dataOffset: dataStart,
      });
    }

    offset = dataStart + paddedDataSize;
  }

  return entries;
}

const tarEntriesCache = new Map<string, { sig: string; entries: ArchiveEntryInfo[] }>();
const MAX_TAR_CACHE = 8;

function setTarCache(archivePath: string, sig: string, entries: ArchiveEntryInfo[]): void {
  if (tarEntriesCache.size >= MAX_TAR_CACHE) {
    const oldest = tarEntriesCache.keys().next().value;
    if (oldest) {
      tarEntriesCache.delete(oldest);
    }
  }
  tarEntriesCache.set(archivePath, { sig, entries });
}

/**
 * Read TAR headers by seeking past file payloads without reading file contents.
 */
export async function readTarEntries(archivePath: string): Promise<ArchiveEntryInfo[]> {
  const handle = await fs.open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    const sig = `${stat.size}:${stat.mtimeMs}`;
    const cached = tarEntriesCache.get(archivePath);
    if (cached && cached.sig === sig) {
      return cached.entries;
    }
    const headerBuf = Buffer.alloc(512);
    const entries: ArchiveEntryInfo[] = [];
    let offset = 0;
    let nextLongName: string | null = null;

    while (offset + 512 <= stat.size) {
      const { bytesRead } = await handle.read(headerBuf, 0, 512, offset);
      if (bytesRead < 512 || isZeroBlock(headerBuf)) {
        break;
      }

      const namePart = readNullTerminatedString(headerBuf, 0, 100);
      const size = parseOctal(headerBuf, 124, 136);
      const mtimeSec = parseOctal(headerBuf, 136, 148);
      const typeFlag = String.fromCharCode(headerBuf[156]);
      const prefixPart = readNullTerminatedString(headerBuf, 345, 500);

      const dataStart = offset + 512;
      const paddedDataSize = Math.ceil(size / 512) * 512;

      if (typeFlag === 'L' || typeFlag === 'x') {
        const metaBuf = Buffer.alloc(size);
        await handle.read(metaBuf, 0, size, dataStart);
        if (typeFlag === 'L') {
          nextLongName = readNullTerminatedString(metaBuf, 0, size);
        } else {
          const paxPath = parsePaxPath(metaBuf);
          if (paxPath) {
            nextLongName = paxPath;
          }
        }
        offset = dataStart + paddedDataSize;
        continue;
      }

      if (typeFlag === 'g') {
        offset = dataStart + paddedDataSize;
        continue;
      }

      const rawName = nextLongName ?? (prefixPart ? `${prefixPart}/${namePart}` : namePart);
      nextLongName = null;

      const normalized = rawName.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      const isDir = typeFlag === '5' || normalized.endsWith('/');
      const innerPath = normalized.replace(/\/+$/, '');

      if (innerPath && (typeFlag === '0' || typeFlag === '\0' || typeFlag === '5' || typeFlag === '2')) {
        entries.push({
          innerPath,
          isDirectory: isDir,
          size: isDir ? 0 : size,
          mtimeMs: mtimeSec * 1000,
          dataOffset: dataStart,
        });
      }

      offset = dataStart + paddedDataSize;
    }

    setTarCache(archivePath, sig, entries);
    return entries;
  } finally {
    await handle.close();
  }
}

export async function readTarGzEntries(archivePath: string): Promise<ArchiveEntryInfo[]> {
  const stat = await fs.stat(archivePath);
  const sig = `${stat.size}:${stat.mtimeMs}`;
  const cached = tarEntriesCache.get(archivePath);
  if (cached && cached.sig === sig) {
    return cached.entries;
  }
  const gzBuf = await fs.readFile(archivePath);
  const tarBuf = zlib.gunzipSync(gzBuf);
  const entries = parseTarBuffer(tarBuf);
  setTarCache(archivePath, sig, entries);
  return entries;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export async function listArchiveDirectory(
  archivePath: string,
  innerDir: string,
  options: {
    showDotFiles: boolean;
    sortField: SortField;
    sortOrder: SortOrder;
    mask?: string;
  }
): Promise<FileEntry[]> {
  const kind = getArchiveKind(archivePath);
  let allEntries: ArchiveEntryInfo[];

  if (kind === 'zip') {
    allEntries = await readZipEntries(archivePath);
  } else if (kind === 'tar') {
    allEntries = await readTarEntries(archivePath);
  } else if (kind === 'tar.gz') {
    allEntries = await readTarGzEntries(archivePath);
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }

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

export async function extractArchiveEntryToTempFile(
  archivePath: string,
  innerPath: string
): Promise<string> {
  const kind = getArchiveKind(archivePath);
  if (kind === 'zip') {
    return extractZipEntryToTempFile(archivePath, innerPath);
  }

  let content: Buffer;
  if (kind === 'tar') {
    const entries = await readTarEntries(archivePath);
    const target = entries.find((e) => !e.isDirectory && e.innerPath === innerPath);
    if (!target || target.dataOffset === undefined) {
      throw new Error(`Entry not found in archive: ${innerPath}`);
    }
    content = Buffer.alloc(target.size);
    const handle = await fs.open(archivePath, 'r');
    try {
      await handle.read(content, 0, target.size, target.dataOffset);
    } finally {
      await handle.close();
    }
  } else if (kind === 'tar.gz') {
    const gzBuf = await fs.readFile(archivePath);
    const tarBuf = zlib.gunzipSync(gzBuf);
    const entries = parseTarBuffer(tarBuf);
    const target = entries.find((e) => !e.isDirectory && e.innerPath === innerPath);
    if (!target || target.dataOffset === undefined) {
      throw new Error(`Entry not found in archive: ${innerPath}`);
    }
    content = tarBuf.subarray(target.dataOffset, target.dataOffset + target.size);
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }

  const tempRoot = path.join(os.tmpdir(), 'vscode-filer-archive');
  const safeRel = innerPath.split('/').filter((seg) => seg && seg !== '..').join(path.sep);
  const outPath = path.join(tempRoot, path.basename(archivePath), safeRel);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, content);
  return outPath;
}
