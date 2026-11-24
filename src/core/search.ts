import * as fs from 'fs/promises';
import * as path from 'path';
import { globToRegExp } from './paneManager';
import { FileEntry } from './types';

const MAX_VIRTUAL_RESULTS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SEARCH_BATCH_SIZE = 32;

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

    const subDirs: string[] = [];
    const matchedPaths: string[] = [];

    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) {
          continue;
        }
        const subFull = path.join(dir, dirent.name);
        if (regex.test(dirent.name)) {
          matchedPaths.push(subFull);
        }
        subDirs.push(subFull);
      } else if (regex.test(dirent.name)) {
        matchedPaths.push(path.join(dir, dirent.name));
      }
    }

    for (let i = 0; i < matchedPaths.length && results.length < MAX_VIRTUAL_RESULTS; i += SEARCH_BATCH_SIZE) {
      const remaining = MAX_VIRTUAL_RESULTS - results.length;
      const batch = matchedPaths.slice(i, i + Math.min(SEARCH_BATCH_SIZE, remaining));
      const entries = await Promise.all(batch.map((p) => buildFileEntry(p, rootDir)));
      for (const entry of entries) {
        if (entry && results.length < MAX_VIRTUAL_RESULTS) {
          results.push(entry);
        }
      }
    }

    for (const subDir of subDirs) {
      if (results.length >= MAX_VIRTUAL_RESULTS) {
        break;
      }
      await walk(subDir);
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

    const subDirs: string[] = [];
    const filePaths: string[] = [];

    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (!SKIP_DIRS.has(dirent.name)) {
          subDirs.push(path.join(dir, dirent.name));
        }
      } else if (dirent.isFile()) {
        filePaths.push(path.join(dir, dirent.name));
      }
    }

    for (let i = 0; i < filePaths.length && results.length < MAX_VIRTUAL_RESULTS; i += SEARCH_BATCH_SIZE) {
      const batch = filePaths.slice(i, i + SEARCH_BATCH_SIZE);
      const matched = await Promise.all(
        batch.map(async (fullPath): Promise<FileEntry | null> => {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size > 2 * 1024 * 1024) {
              return null; // Skip large files > 2MB
            }
            const buf = await fs.readFile(fullPath);
            if (buf.includes(0)) {
              return null; // Skip binary files
            }
            const text = buf.toString('utf8');
            if (regex.test(text)) {
              return buildFileEntry(fullPath, rootDir);
            }
          } catch {
            // Ignore read error
          }
          return null;
        })
      );

      for (const entry of matched) {
        if (entry && results.length < MAX_VIRTUAL_RESULTS) {
          results.push(entry);
        }
      }
    }

    for (const subDir of subDirs) {
      if (results.length >= MAX_VIRTUAL_RESULTS) {
        break;
      }
      await walk(subDir);
    }
  }

  await walk(rootDir);
  return results;
}

