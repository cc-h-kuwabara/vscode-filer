import * as fs from 'fs/promises';
import * as path from 'path';
import { globToRegExp } from './paneManager';
import { FileEntry } from './types';

const MAX_VIRTUAL_RESULTS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git']);

async function buildFileEntry(fullPath: string, rootDir: string): Promise<FileEntry | null> {
  try {
    const lstat = await fs.lstat(fullPath);
    const isSymlink = lstat.isSymbolicLink();
    let isDirectory = lstat.isDirectory();
    let size = lstat.size;
    let mtimeMs = lstat.mtimeMs;

    if (isSymlink) {
      try {
        const stat = await fs.stat(fullPath);
        isDirectory = stat.isDirectory();
        size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        isDirectory = false;
      }
    }

    const rel = path.relative(rootDir, fullPath) || path.basename(fullPath);
    return {
      name: rel,
      path: fullPath,
      isDirectory,
      isSymlink,
      size,
      mtimeMs,
      mode: lstat.mode,
      marked: false,
    };
  } catch {
    return null;
  }
}

export async function findEntries(rootDir: string, pattern: string): Promise<FileEntry[]> {
  const regex = globToRegExp(pattern.trim() || '*');
  const results: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_VIRTUAL_RESULTS) {
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (results.length >= MAX_VIRTUAL_RESULTS) {
        return;
      }
      if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) {
        continue;
      }
      const fullPath = path.join(dir, dirent.name);
      if (regex.test(dirent.name)) {
        const entry = await buildFileEntry(fullPath, rootDir);
        if (entry) {
          results.push(entry);
        }
      }
      if (dirent.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

export async function grepEntries(rootDir: string, query: string): Promise<FileEntry[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  let regex: RegExp;
  try {
    regex = new RegExp(trimmed, 'i');
  } catch {
    regex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const results: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_VIRTUAL_RESULTS) {
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (results.length >= MAX_VIRTUAL_RESULTS) {
        return;
      }
      if (dirent.isDirectory()) {
        if (!SKIP_DIRS.has(dirent.name)) {
          await walk(path.join(dir, dirent.name));
        }
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }

      const fullPath = path.join(dir, dirent.name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > 2 * 1024 * 1024) {
          continue; // Skip large files > 2MB
        }
        const buf = await fs.readFile(fullPath);
        if (buf.includes(0)) {
          continue; // Skip binary files
        }
        const text = buf.toString('utf8');
        if (regex.test(text)) {
          const entry = await buildFileEntry(fullPath, rootDir);
          if (entry) {
            results.push(entry);
          }
        }
      } catch {
        // Ignore read error
      }
    }
  }

  await walk(rootDir);
  return results;
}

