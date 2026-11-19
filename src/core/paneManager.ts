import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getArchiveKind, listArchiveDirectory } from './archiveReader';
import { FileEntry, PaneId, PaneState, SortField, SortOrder } from './types';
import { sortFileEntries } from './zipReader';

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.ps1', '.com', '.msi']);

export function isExecutableFile(
  name: string,
  isDirectory: boolean,
  mode: number,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (isDirectory) {
    return false;
  }
  if (platform === 'win32') {
    return EXECUTABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
  }
  return (mode & 0o111) !== 0;
}

export function isReadOnlyMode(mode: number, statOk: boolean): boolean {
  return statOk && (mode & 0o222) === 0;
}

export class PaneManager {
  private panes: [PaneState, PaneState];
  private activePane: PaneId = 0;
  private rangeMarkAnchor: [number | null, number | null] = [null, null];

  constructor(initialLeftDir?: string, initialRightDir?: string, showDotFiles = true) {
    const home = os.homedir();
    const left = initialLeftDir || home;
    const right = initialRightDir || left;

    this.panes = [
      this.createInitialPane(0, left, showDotFiles),
      this.createInitialPane(1, right, showDotFiles),
    ];
  }

  private createInitialPane(id: PaneId, cwd: string, showDotFiles: boolean): PaneState {
    const resolved = path.resolve(cwd);
    return {
      id,
      cwd: resolved,
      entries: [],
      cursor: 0,
      showDotFiles,
      sortField: 'name',
      sortOrder: 'asc',
      mask: '',
      isVirtual: false,
      history: [resolved],
      historyIndex: 0,
    };
  }

  public getActivePaneId(): PaneId {
    return this.activePane;
  }

  public getInactivePaneId(): PaneId {
    return this.activePane === 0 ? 1 : 0;
  }

  public getPane(id: PaneId): PaneState {
    return this.panes[id];
  }

  public getActivePane(): PaneState {
    return this.panes[this.activePane];
  }

  public getInactivePane(): PaneState {
    return this.panes[this.getInactivePaneId()];
  }

  public getPanes(): [PaneState, PaneState] {
    return this.panes;
  }

  public setActivePane(id: PaneId): void {
    this.activePane = id;
  }

  public switchPane(): void {
    this.activePane = this.getInactivePaneId();
  }

  public async reloadAll(): Promise<void> {
    await Promise.all([this.reloadPane(0), this.reloadPane(1)]);
  }

  public async reloadPane(id: PaneId, preserveSelectionName?: string): Promise<void> {
    const pane = this.panes[id];
    const prevName =
      preserveSelectionName ?? pane.entries[pane.cursor]?.name;

    if (pane.virtualArchive) {
      pane.entries = await listArchiveDirectory(
        pane.virtualArchive.archivePath,
        pane.virtualArchive.innerDir,
        {
          showDotFiles: pane.showDotFiles,
          sortField: pane.sortField,
          sortOrder: pane.sortOrder,
          mask: pane.mask,
        }
      );
      this.rangeMarkAnchor[id] = null;
      if (prevName) {
        const idx = pane.entries.findIndex((e) => e.name === prevName);
        pane.cursor = idx >= 0 ? idx : Math.min(pane.cursor, Math.max(0, pane.entries.length - 1));
      } else {
        pane.cursor = Math.min(pane.cursor, Math.max(0, pane.entries.length - 1));
      }
      return;
    }

    if (pane.isVirtual) {
      return;
    }

    const dirents = await fs.readdir(pane.cwd, { withFileTypes: true });
    const entries: FileEntry[] = [];

    const parentPath = path.dirname(pane.cwd);
    if (parentPath !== pane.cwd) {
      entries.push({
        name: '..',
        path: parentPath,
        isDirectory: true,
        isSymlink: false,
        size: 0,
        mtimeMs: 0,
        mode: 0o755,
        marked: false,
      });
    }

    const maskRegex = pane.mask.trim() ? globToRegExp(pane.mask.trim()) : null;

    const items = await Promise.all(
      dirents.map(async (dirent): Promise<FileEntry | null> => {
        const name = dirent.name;
        if (!pane.showDotFiles && name.startsWith('.')) {
          return null;
        }

        const fullPath = path.join(pane.cwd, name);
        let isDirectory = dirent.isDirectory();
        const isSymlink = dirent.isSymbolicLink();
        let isBrokenSymlink = false;
        let statOk = false;
        let linkTarget: string | undefined;
        let size = 0;
        let mtimeMs = 0;
        let mode = 0;

        try {
          const lstat = await fs.lstat(fullPath);
          statOk = true;
          size = lstat.size;
          mtimeMs = lstat.mtimeMs;
          mode = lstat.mode;

          if (isSymlink) {
            try {
              linkTarget = await fs.readlink(fullPath);
              const stat = await fs.stat(fullPath);
              isDirectory = stat.isDirectory();
              size = stat.size;
              mtimeMs = stat.mtimeMs;
              mode = stat.mode;
            } catch {
              // Broken symlink
              isDirectory = false;
              isBrokenSymlink = true;
            }
          }
        } catch {
          // Permission or transient error
        }

        if (maskRegex && !isDirectory && !maskRegex.test(name)) {
          return null;
        }

        const isHidden = name.startsWith('.') && name !== '..';
        const isReadOnly = !isBrokenSymlink && isReadOnlyMode(mode, statOk);
        const isExecutable = !isBrokenSymlink && isExecutableFile(name, isDirectory, mode);

        return {
          name,
          path: fullPath,
          isDirectory,
          isSymlink,
          isBrokenSymlink,
          isReadOnly,
          isHidden,
          isExecutable,
          linkTarget,
          size,
          mtimeMs,
          mode,
          marked: false,
        };
      })
    );

    const validItems = items.filter((item): item is FileEntry => item !== null);
    sortFileEntries(validItems, pane.sortField, pane.sortOrder);

    pane.entries = [...entries, ...validItems];
    this.rangeMarkAnchor[id] = null;

    if (prevName) {
      const idx = pane.entries.findIndex((e) => e.name === prevName);
      if (idx >= 0) {
        pane.cursor = idx;
      } else {
        pane.cursor = Math.min(pane.cursor, Math.max(0, pane.entries.length - 1));
      }
    } else {
      pane.cursor = Math.min(pane.cursor, Math.max(0, pane.entries.length - 1));
    }
  }

  public async cd(id: PaneId, targetDir: string, recordHistory = true, focusChildName?: string): Promise<void> {
    const pane = this.panes[id];
    const resolved = path.resolve(pane.cwd, targetDir);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }

    pane.isVirtual = false;
    pane.virtualLabel = undefined;
    pane.virtualArchive = undefined;
    pane.cwd = resolved;
    pane.cursor = 0;

    if (recordHistory) {
      if (pane.history[pane.historyIndex] !== resolved) {
        pane.history = pane.history.slice(0, pane.historyIndex + 1);
        pane.history.push(resolved);
        if (pane.history.length > 100) {
          pane.history.shift();
        }
        pane.historyIndex = pane.history.length - 1;
      }
    }

    await this.reloadPane(id, focusChildName);
  }

  public async enterArchive(
    id: PaneId,
    archivePath: string,
    innerDir = '',
    focusChildName?: string
  ): Promise<void> {
    const pane = this.panes[id];
    const normalizedInner = innerDir.replace(/^\/+|\/+$/g, '');
    const archiveName = path.basename(archivePath);
    const kind = (getArchiveKind(archiveName) ?? 'zip').toUpperCase();

    pane.isVirtual = true;
    pane.virtualArchive = {
      archivePath,
      archiveName,
      innerDir: normalizedInner,
    };
    pane.virtualLabel = normalizedInner
      ? `[${kind}: ${archiveName}/${normalizedInner}]`
      : `[${kind}: ${archiveName}]`;
    pane.cursor = 0;

    await this.reloadPane(id, focusChildName);
  }

  public async parentDir(id: PaneId): Promise<void> {
    const pane = this.panes[id];
    if (pane.virtualArchive) {
      const { archivePath, archiveName, innerDir } = pane.virtualArchive;
      if (!innerDir) {
        pane.virtualArchive = undefined;
        pane.isVirtual = false;
        pane.virtualLabel = undefined;
        await this.reloadPane(id, archiveName);
        return;
      }
      const parts = innerDir.split('/');
      const currentFolder = parts.pop();
      const parentInnerDir = parts.join('/');
      await this.enterArchive(id, archivePath, parentInnerDir, currentFolder);
      return;
    }

    if (pane.isVirtual) {
      pane.isVirtual = false;
      pane.virtualLabel = undefined;
      await this.reloadPane(id);
      return;
    }

    const parent = path.dirname(pane.cwd);
    if (parent === pane.cwd) {
      return;
    }
    const currentFolderName = path.basename(pane.cwd);
    await this.cd(id, parent, true, currentFolderName);
  }

  public async historyBack(id: PaneId): Promise<boolean> {
    const pane = this.panes[id];
    if (pane.historyIndex <= 0) {
      return false;
    }
    pane.historyIndex -= 1;
    await this.cd(id, pane.history[pane.historyIndex], false);
    return true;
  }

  public async historyForward(id: PaneId): Promise<boolean> {
    const pane = this.panes[id];
    if (pane.historyIndex >= pane.history.length - 1) {
      return false;
    }
    pane.historyIndex += 1;
    await this.cd(id, pane.history[pane.historyIndex], false);
    return true;
  }

  public moveCursor(id: PaneId, delta: number): void {
    const pane = this.panes[id];
    if (pane.entries.length === 0) {
      pane.cursor = 0;
      return;
    }
    pane.cursor = Math.max(0, Math.min(pane.entries.length - 1, pane.cursor + delta));
  }

  public setCursor(id: PaneId, index: number): void {
    const pane = this.panes[id];
    if (pane.entries.length === 0) {
      pane.cursor = 0;
      return;
    }
    pane.cursor = Math.max(0, Math.min(pane.entries.length - 1, index));
  }

  public cursorTop(id: PaneId): void {
    this.setCursor(id, 0);
  }

  public cursorBottom(id: PaneId): void {
    const pane = this.panes[id];
    this.setCursor(id, Math.max(0, pane.entries.length - 1));
  }

  public getCursorEntry(id: PaneId): FileEntry | undefined {
    const pane = this.panes[id];
    return pane.entries[pane.cursor];
  }

  public toggleMarkAndMoveDown(id: PaneId): void {
    const pane = this.panes[id];
    const entry = pane.entries[pane.cursor];
    if (entry && entry.name !== '..') {
      entry.marked = !entry.marked;
    }
    this.moveCursor(id, 1);
  }

  public setRangeMarkStart(id: PaneId): void {
    this.rangeMarkAnchor[id] = this.panes[id].cursor;
  }

  public applyRangeMarkEnd(id: PaneId): number {
    const pane = this.panes[id];
    const start = this.rangeMarkAnchor[id];
    if (start === null) {
      return 0;
    }
    const end = pane.cursor;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    let count = 0;
    for (let i = low; i <= high; i++) {
      const entry = pane.entries[i];
      if (entry && entry.name !== '..') {
        entry.marked = !entry.marked;
        count++;
      }
    }
    this.rangeMarkAnchor[id] = null;
    return count;
  }

  public invertMarks(id: PaneId, filesOnly: boolean): void {
    const pane = this.panes[id];
    for (const entry of pane.entries) {
      if (entry.name === '..') {
        continue;
      }
      if (filesOnly && entry.isDirectory) {
        continue;
      }
      entry.marked = !entry.marked;
    }
  }

  public markAllFiles(id: PaneId): number {
    let count = 0;
    for (const entry of this.panes[id].entries) {
      if (entry.name === '..' || entry.isDirectory) {
        continue;
      }
      entry.marked = true;
      count++;
    }
    return count;
  }

  public clearAllMarks(id: PaneId): number {
    let count = 0;
    for (const entry of this.panes[id].entries) {
      if (entry.marked) {
        entry.marked = false;
        count++;
      }
    }
    return count;
  }

  public markByGlob(id: PaneId, pattern: string): number {
    const regex = globToRegExp(pattern);
    let count = 0;
    for (const entry of this.panes[id].entries) {
      if (entry.name === '..') {
        continue;
      }
      if (regex.test(entry.name)) {
        entry.marked = !entry.marked;
        count++;
      }
    }
    return count;
  }

  public markByRegex(id: PaneId, pattern: string): number {
    const regex = new RegExp(pattern);
    let count = 0;
    for (const entry of this.panes[id].entries) {
      if (entry.name === '..') {
        continue;
      }
      if (regex.test(entry.name)) {
        entry.marked = !entry.marked;
        count++;
      }
    }
    return count;
  }

  public markSameNameFiles(id: PaneId): number {
    const activePane = this.panes[id];
    const otherPane = this.panes[id === 0 ? 1 : 0];
    const otherFileNames = new Set(
      otherPane.entries
        .filter((e) => e.name !== '..' && !e.isDirectory)
        .map((e) => e.name)
    );
    let count = 0;
    for (const entry of activePane.entries) {
      if (entry.name === '..' || entry.isDirectory) {
        continue;
      }
      if (otherFileNames.has(entry.name)) {
        entry.marked = true;
        count++;
      }
    }
    return count;
  }

  public getTargetEntries(id: PaneId): FileEntry[] {
    const pane = this.panes[id];
    const marked = pane.entries.filter((e) => e.marked && e.name !== '..');
    if (marked.length > 0) {
      return marked;
    }
    const current = pane.entries[pane.cursor];
    if (current && current.name !== '..') {
      return [current];
    }
    return [];
  }

  public async toggleDotFiles(id: PaneId): Promise<boolean> {
    const pane = this.panes[id];
    pane.showDotFiles = !pane.showDotFiles;
    await this.reloadPane(id);
    return pane.showDotFiles;
  }

  public async setSort(id: PaneId, field: SortField, order: SortOrder): Promise<void> {
    const pane = this.panes[id];
    pane.sortField = field;
    pane.sortOrder = order;
    await this.reloadPane(id);
  }

  public async setMask(id: PaneId, mask: string): Promise<void> {
    const pane = this.panes[id];
    pane.mask = mask;
    await this.reloadPane(id);
  }

  public setVirtualEntries(id: PaneId, label: string, entries: FileEntry[]): void {
    const pane = this.panes[id];
    pane.isVirtual = true;
    pane.virtualLabel = label;
    pane.virtualArchive = undefined;
    pane.entries = entries;
    pane.cursor = 0;
  }

  public async syncActiveToOther(): Promise<void> {
    const active = this.getActivePane();
    const otherId = this.getInactivePaneId();
    await this.cd(otherId, active.cwd);
  }

  public async syncOtherToActive(): Promise<void> {
    const other = this.getInactivePane();
    await this.cd(this.activePane, other.cwd);
  }

  public async swapPanes(): Promise<void> {
    const leftPath = this.panes[0].cwd;
    const rightPath = this.panes[1].cwd;
    await Promise.all([this.cd(0, rightPath), this.cd(1, leftPath)]);
  }
}

