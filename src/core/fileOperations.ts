import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { OperationLogger } from './logger';
import { FileEntry, OverwriteDecision, OverwriteFileInfo } from './types';

export type { OverwriteDecision };

const execFileAsync = promisify(execFile);

export interface FileOpsHooks {
  confirmOverwrite?: (targetPath: string, sourcePath?: string) => Promise<OverwriteDecision>;
  moveToTrash?: (targetPath: string) => Promise<void>;
}

export async function getOverwriteFileInfo(filePath: string): Promise<OverwriteFileInfo> {
  const name = path.basename(filePath);
  try {
    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isDirectory: stat.isDirectory(),
      available: true,
    };
  } catch {
    try {
      const lstat = await fs.lstat(filePath);
      return {
        path: filePath,
        name,
        size: lstat.size,
        mtimeMs: lstat.mtimeMs,
        isDirectory: lstat.isDirectory(),
        available: true,
      };
    } catch {
      return {
        path: filePath,
        name,
        size: 0,
        mtimeMs: 0,
        isDirectory: false,
        available: false,
      };
    }
  }
}

export function formatDateTime(mtimeMs: number): string {
  if (!mtimeMs) {
    return 'unknown';
  }
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatFileSize(bytes: number): string {
  const exact = `${bytes.toLocaleString('en-US')} B`;
  if (bytes < 1024) {
    return exact;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB (${exact})`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB (${exact})`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB (${exact})`;
}

async function describeFileForOverwrite(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    const sizeText = stat.isDirectory() ? '<DIR>' : formatFileSize(stat.size);
    const dateText = formatDateTime(stat.mtimeMs);
    return `${dateText} | ${sizeText}\n  ${filePath}`;
  } catch {
    try {
      const lstat = await fs.lstat(filePath);
      const sizeText = lstat.isDirectory() ? '<DIR>' : formatFileSize(lstat.size);
      const dateText = formatDateTime(lstat.mtimeMs);
      return `${dateText} | ${sizeText}\n  ${filePath}`;
    } catch {
      return `(unavailable)\n  ${filePath}`;
    }
  }
}

export async function formatOverwriteDetail(targetPath: string, sourcePath?: string): Promise<string> {
  const existingInfo = await describeFileForOverwrite(targetPath);
  if (!sourcePath) {
    return `Existing (Target):\n  ${existingInfo}`;
  }
  const sourceInfo = await describeFileForOverwrite(sourcePath);
  return `Source (New):\n  ${sourceInfo}\n\nExisting (Target):\n  ${existingInfo}`;
}

interface OverwriteSession {
  sticky: 'overwrite' | 'skip' | null;
}

export class FileOperations {
  constructor(
    private readonly logger: OperationLogger,
    private readonly hooks: FileOpsHooks = {}
  ) {}

  private async resolveOverwrite(
    destPath: string,
    srcPath: string,
    session: OverwriteSession
  ): Promise<'overwrite' | 'skip' | 'cancel'> {
    if (session.sticky) {
      return session.sticky;
    }
    if (!this.hooks.confirmOverwrite) {
      return 'overwrite';
    }
    const decision = await this.hooks.confirmOverwrite(destPath, srcPath);
    if (decision === 'overwriteAll') {
      session.sticky = 'overwrite';
      return 'overwrite';
    }
    if (decision === 'skipAll') {
      session.sticky = 'skip';
      return 'skip';
    }
    return decision;
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async copySingleFile(
    srcPath: string,
    destPath: string,
    session: OverwriteSession
  ): Promise<'copied' | 'skipped' | 'failed' | 'cancelled'> {
    if (await this.exists(destPath)) {
      const decision = await this.resolveOverwrite(destPath, srcPath, session);
      if (decision === 'cancel') {
        this.logger.warn(`COPY CANCELLED: ${destPath}`);
        return 'cancelled';
      }
      if (decision === 'skip') {
        this.logger.info(`SKIP COPY (exists): ${destPath}`);
        return 'skipped';
      }
    }

    try {
      await fs.cp(srcPath, destPath, { force: true });
      this.logger.success(`COPY: ${srcPath} -> ${destPath}`);
      return 'copied';
    } catch (err) {
      this.logger.error(`COPY FAILED: ${srcPath} (${String(err)})`);
      return 'failed';
    }
  }

  private async copyDirectoryRecursive(
    srcDir: string,
    destDir: string,
    session: OverwriteSession
  ): Promise<'copied' | 'failed' | 'cancelled'> {
    try {
      await fs.mkdir(destDir, { recursive: true });
      const items = await fs.readdir(srcDir, { withFileTypes: true });
      for (const item of items) {
        const srcChild = path.join(srcDir, item.name);
        const destChild = path.join(destDir, item.name);
        if (item.isDirectory()) {
          const dirResult = await this.copyDirectoryRecursive(srcChild, destChild, session);
          if (dirResult === 'cancelled') {
            return 'cancelled';
          }
        } else {
          const fileResult = await this.copySingleFile(srcChild, destChild, session);
          if (fileResult === 'cancelled') {
            return 'cancelled';
          }
        }
      }
      return 'copied';
    } catch (err) {
      this.logger.error(`COPY FAILED: ${srcDir} (${String(err)})`);
      return 'failed';
    }
  }

  public async copyEntries(entries: FileEntry[], destDir: string): Promise<number> {
    let successCount = 0;
    const session: OverwriteSession = { sticky: null };
    for (const entry of entries) {
      const destPath = path.join(destDir, path.basename(entry.path));
      if (path.resolve(entry.path) === path.resolve(destPath)) {
        this.logger.warn(`SKIP COPY (same path): ${entry.path}`);
        continue;
      }

      if (entry.isDirectory) {
        const result = await this.copyDirectoryRecursive(entry.path, destPath, session);
        if (result === 'cancelled') {
          break;
        }
        if (result === 'copied') {
          this.logger.success(`COPY: ${entry.path} -> ${destPath}`);
          successCount++;
        }
      } else {
        const result = await this.copySingleFile(entry.path, destPath, session);
        if (result === 'cancelled') {
          break;
        }
        if (result === 'copied') {
          successCount++;
        }
      }
    }
    return successCount;
  }

  private async moveSingleFile(
    srcPath: string,
    destPath: string,
    session: OverwriteSession
  ): Promise<'moved' | 'skipped' | 'failed' | 'cancelled'> {
    if (await this.exists(destPath)) {
      const decision = await this.resolveOverwrite(destPath, srcPath, session);
      if (decision === 'cancel') {
        this.logger.warn(`MOVE CANCELLED: ${destPath}`);
        return 'cancelled';
      }
      if (decision === 'skip') {
        this.logger.info(`SKIP MOVE (exists): ${destPath}`);
        return 'skipped';
      }
    }

    try {
      await fs.rename(srcPath, destPath);
      this.logger.success(`MOVE: ${srcPath} -> ${destPath}`);
      return 'moved';
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EXDEV') {
        try {
          await fs.cp(srcPath, destPath, { force: true });
          await fs.rm(srcPath, { force: true });
          this.logger.success(`MOVE: ${srcPath} -> ${destPath}`);
          return 'moved';
        } catch (innerErr) {
          this.logger.error(`MOVE FAILED: ${srcPath} (${String(innerErr)})`);
          return 'failed';
        }
      }
      this.logger.error(`MOVE FAILED: ${srcPath} (${String(err)})`);
      return 'failed';
    }
  }

  private async moveDirectoryMerge(
    srcDir: string,
    destDir: string,
    session: OverwriteSession
  ): Promise<'moved' | 'failed' | 'cancelled'> {
    try {
      await fs.mkdir(destDir, { recursive: true });
      const items = await fs.readdir(srcDir, { withFileTypes: true });
      let allMoved = true;
      for (const item of items) {
        const srcChild = path.join(srcDir, item.name);
        const destChild = path.join(destDir, item.name);
        if (item.isDirectory()) {
          if (!(await this.exists(destChild))) {
            try {
              await fs.rename(srcChild, destChild);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
                const res = await this.moveDirectoryMerge(srcChild, destChild, session);
                if (res === 'cancelled') {
                  return 'cancelled';
                }
                if (res !== 'moved') {
                  allMoved = false;
                }
              } else {
                this.logger.error(`MOVE FAILED: ${srcChild} (${String(err)})`);
                allMoved = false;
              }
            }
          } else {
            const res = await this.moveDirectoryMerge(srcChild, destChild, session);
            if (res === 'cancelled') {
              return 'cancelled';
            }
            if (res !== 'moved') {
              allMoved = false;
            }
          }
        } else {
          const result = await this.moveSingleFile(srcChild, destChild, session);
          if (result === 'cancelled') {
            return 'cancelled';
          }
          if (result !== 'moved') {
            allMoved = false;
          }
        }
      }
      if (allMoved) {
        await fs.rmdir(srcDir);
      }
      return 'moved';
    } catch (err) {
      this.logger.error(`MOVE FAILED: ${srcDir} (${String(err)})`);
      return 'failed';
    }
  }

  public async moveEntries(entries: FileEntry[], destDir: string): Promise<number> {
    let successCount = 0;
    const session: OverwriteSession = { sticky: null };
    for (const entry of entries) {
      const destPath = path.join(destDir, path.basename(entry.path));
      if (path.resolve(entry.path) === path.resolve(destPath)) {
        this.logger.warn(`SKIP MOVE (same path): ${entry.path}`);
        continue;
      }

      if (entry.isDirectory) {
        if (!(await this.exists(destPath))) {
          try {
            await fs.rename(entry.path, destPath);
            this.logger.success(`MOVE: ${entry.path} -> ${destPath}`);
            successCount++;
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
              const res = await this.moveDirectoryMerge(entry.path, destPath, session);
              if (res === 'cancelled') {
                break;
              }
              if (res === 'moved') {
                this.logger.success(`MOVE (cross-device): ${entry.path} -> ${destPath}`);
                successCount++;
              }
            } else {
              this.logger.error(`MOVE FAILED: ${entry.path} (${String(err)})`);
            }
          }
        } else {
          const res = await this.moveDirectoryMerge(entry.path, destPath, session);
          if (res === 'cancelled') {
            break;
          }
          if (res === 'moved') {
            this.logger.success(`MOVE: ${entry.path} -> ${destPath}`);
            successCount++;
          }
        }
      } else {
        const result = await this.moveSingleFile(entry.path, destPath, session);
        if (result === 'cancelled') {
          break;
        }
        if (result === 'moved') {
          successCount++;
        }
      }
    }
    return successCount;
  }

  public async trashEntries(entries: FileEntry[]): Promise<number> {
    let successCount = 0;
    for (const entry of entries) {
      try {
        if (this.hooks.moveToTrash) {
          await this.hooks.moveToTrash(entry.path);
        } else {
          await fs.rm(entry.path, { recursive: true, force: true });
        }
        this.logger.success(`TRASH: ${entry.path}`);
        successCount++;
      } catch (err) {
        this.logger.error(`TRASH FAILED: ${entry.path} (${String(err)})`);
      }
    }
    return successCount;
  }

  public async deletePermanentEntries(entries: FileEntry[]): Promise<number> {
    let successCount = 0;
    for (const entry of entries) {
      try {
        await fs.rm(entry.path, { recursive: true, force: true });
        this.logger.success(`DELETE: ${entry.path}`);
        successCount++;
      } catch (err) {
        this.logger.error(`DELETE FAILED: ${entry.path} (${String(err)})`);
      }
    }
    return successCount;
  }

  public async createSymlinks(entries: FileEntry[], destDir: string): Promise<number> {
    let successCount = 0;
    for (const entry of entries) {
      const linkPath = path.join(destDir, path.basename(entry.path));
      try {
        await fs.symlink(entry.path, linkPath);
        this.logger.success(`SYMLINK: ${linkPath} -> ${entry.path}`);
        successCount++;
      } catch (err) {
        this.logger.error(`SYMLINK FAILED: ${linkPath} (${String(err)})`);
      }
    }
    return successCount;
  }

  public async renameEntry(entry: FileEntry, newName: string): Promise<boolean> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) {
      return false;
    }
    const dir = path.dirname(entry.path);
    const destPath = path.join(dir, trimmed);
    try {
      await fs.rename(entry.path, destPath);
      this.logger.success(`RENAME: ${entry.name} -> ${trimmed}`);
      return true;
    } catch (err) {
      this.logger.error(`RENAME FAILED: ${entry.name} (${String(err)})`);
      return false;
    }
  }

  public async regexRenameEntries(
    entries: FileEntry[],
    pattern: string,
    replacement: string
  ): Promise<number> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (err) {
      this.logger.error(`INVALID REGEX: ${pattern} (${String(err)})`);
      return 0;
    }

    let successCount = 0;
    for (const entry of entries) {
      const newName = entry.name.replace(regex, replacement);
      if (newName === entry.name || !newName) {
        continue;
      }
      const ok = await this.renameEntry(entry, newName);
      if (ok) {
        successCount++;
      }
    }
    return successCount;
  }

  public async makeDirectory(cwd: string, dirName: string): Promise<boolean> {
    const trimmed = dirName.trim();
    if (!trimmed) {
      return false;
    }
    const targetPath = path.resolve(cwd, trimmed);
    try {
      await fs.mkdir(targetPath, { recursive: true });
      this.logger.success(`MKDIR: ${targetPath}`);
      return true;
    } catch (err) {
      this.logger.error(`MKDIR FAILED: ${targetPath} (${String(err)})`);
      return false;
    }
  }

  public async createFile(cwd: string, fileName: string): Promise<boolean> {
    const trimmed = fileName.trim();
    if (!trimmed) {
      return false;
    }
    const targetPath = path.resolve(cwd, trimmed);
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const handle = await fs.open(targetPath, 'a');
      await handle.close();
      this.logger.success(`TOUCH: ${targetPath}`);
      return true;
    } catch (err) {
      this.logger.error(`NEW FILE FAILED: ${targetPath} (${String(err)})`);
      return false;
    }
  }

  public async compressEntries(
    entries: FileEntry[],
    sourceCwd: string,
    archivePath: string
  ): Promise<boolean> {
    if (entries.length === 0) {
      return false;
    }
    const names = entries.map((e) => path.relative(sourceCwd, e.path) || path.basename(e.path));
    const lower = archivePath.toLowerCase();

    try {
      if (lower.endsWith('.zip')) {
        if (process.platform === 'win32') {
          await execFileAsync('tar', ['-a', '-cf', archivePath, ...names], { cwd: sourceCwd });
        } else {
          await execFileAsync('zip', ['-r', archivePath, ...names], { cwd: sourceCwd });
        }
      } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
        await execFileAsync('tar', ['-czf', archivePath, ...names], { cwd: sourceCwd });
      } else if (lower.endsWith('.tar')) {
        await execFileAsync('tar', ['-cf', archivePath, ...names], { cwd: sourceCwd });
      } else {
        const finalPath = `${archivePath}.tar.gz`;
        await execFileAsync('tar', ['-czf', finalPath, ...names], { cwd: sourceCwd });
        this.logger.success(`COMPRESS: ${names.length} item(s) -> ${finalPath}`);
        return true;
      }
      this.logger.success(`COMPRESS: ${names.length} item(s) -> ${archivePath}`);
      return true;
    } catch (err) {
      this.logger.error(`COMPRESS FAILED: ${archivePath} (${String(err)})`);
      return false;
    }
  }

  public async extractArchive(archivePath: string, destDir: string): Promise<boolean> {
    const lower = archivePath.toLowerCase();
    try {
      if (lower.endsWith('.zip')) {
        if (process.platform === 'win32') {
          await execFileAsync('tar', ['-xf', archivePath, '-C', destDir]);
        } else {
          await execFileAsync('unzip', ['-o', archivePath, '-d', destDir]);
        }
      } else if (
        lower.endsWith('.tar.gz') ||
        lower.endsWith('.tgz') ||
        lower.endsWith('.tar.bz2') ||
        lower.endsWith('.tar.xz') ||
        lower.endsWith('.tar')
      ) {
        await execFileAsync('tar', ['-xf', archivePath, '-C', destDir]);
      } else {
        this.logger.error(`UNSUPPORTED ARCHIVE: ${archivePath}`);
        return false;
      }
      this.logger.success(`EXTRACT: ${archivePath} -> ${destDir}`);
      return true;
    } catch (err) {
      this.logger.error(`EXTRACT FAILED: ${archivePath} (${String(err)})`);
      return false;
    }
  }
}

