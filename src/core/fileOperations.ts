import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { OperationLogger } from './logger';
import { FileEntry } from './types';

const execFileAsync = promisify(execFile);

export interface FileOpsHooks {
  confirmOverwrite?: (targetPath: string) => Promise<boolean>;
  moveToTrash?: (targetPath: string) => Promise<void>;
}

export class FileOperations {
  constructor(
    private readonly logger: OperationLogger,
    private readonly hooks: FileOpsHooks = {}
  ) {}

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  public async copyEntries(entries: FileEntry[], destDir: string): Promise<number> {
    let successCount = 0;
    for (const entry of entries) {
      const destPath = path.join(destDir, path.basename(entry.path));
      if (path.resolve(entry.path) === path.resolve(destPath)) {
        this.logger.warn(`SKIP COPY (same path): ${entry.path}`);
        continue;
      }

      if (await this.exists(destPath)) {
        const ok = this.hooks.confirmOverwrite ? await this.hooks.confirmOverwrite(destPath) : true;
        if (!ok) {
          this.logger.info(`SKIP COPY (exists): ${destPath}`);
          continue;
        }
      }

      try {
        await fs.cp(entry.path, destPath, { recursive: true, force: true });
        this.logger.success(`COPY: ${entry.path} -> ${destPath}`);
        successCount++;
      } catch (err) {
        this.logger.error(`COPY FAILED: ${entry.path} (${String(err)})`);
      }
    }
    return successCount;
  }

  public async moveEntries(entries: FileEntry[], destDir: string): Promise<number> {
    let successCount = 0;
    for (const entry of entries) {
      const destPath = path.join(destDir, path.basename(entry.path));
      if (path.resolve(entry.path) === path.resolve(destPath)) {
        this.logger.warn(`SKIP MOVE (same path): ${entry.path}`);
        continue;
      }

      if (await this.exists(destPath)) {
        const ok = this.hooks.confirmOverwrite ? await this.hooks.confirmOverwrite(destPath) : true;
        if (!ok) {
          this.logger.info(`SKIP MOVE (exists): ${destPath}`);
          continue;
        }
      }

      try {
        await fs.rename(entry.path, destPath);
        this.logger.success(`MOVE: ${entry.path} -> ${destPath}`);
        successCount++;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EXDEV') {
          try {
            await fs.cp(entry.path, destPath, { recursive: true, force: true });
            await fs.rm(entry.path, { recursive: true, force: true });
            this.logger.success(`MOVE (cross-device): ${entry.path} -> ${destPath}`);
            successCount++;
          } catch (innerErr) {
            this.logger.error(`MOVE FAILED: ${entry.path} (${String(innerErr)})`);
          }
        } else {
          this.logger.error(`MOVE FAILED: ${entry.path} (${String(err)})`);
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
        await execFileAsync('zip', ['-r', archivePath, ...names], { cwd: sourceCwd });
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
        await execFileAsync('unzip', ['-o', archivePath, '-d', destDir]);
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

