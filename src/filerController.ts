import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DriveEntry,
  extractUncHost,
  isUncNotAllowedError,
  listAvailableLocations,
  normalizeInputPath,
  parseWslUncPath,
} from './core/driveDetector';
import { FileOperations } from './core/fileOperations';
import { mergeKeybindings } from './core/keybindings';
import { OperationLogger } from './core/logger';
import { PaneManager } from './core/paneManager';
import { findEntries, grepEntries } from './core/search';
import {
  ExtensionToWebviewMessage,
  KeybindingsMap,
  PaneId,
  SortField,
  SortOrder,
  WebviewToExtensionMessage,
} from './core/types';

const JUMP_BOOKMARKS_KEY = 'vscodeFiler.jumpBookmarks';
const LAST_PANE_DIRS_KEY = 'vscodeFiler.lastPaneDirs';

interface SavedPaneDirs {
  left: string;
  right: string;
}

export class FilerController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly paneManager: PaneManager;
  private readonly logger: OperationLogger;
  private readonly fileOps: FileOperations;
  private readonly fallbackDir: string;
  private keybindings: KeybindingsMap;
  private readonly disposables: vscode.Disposable[] = [];
  private suppressFocusUntil = 0;
  private lastSavedDirs: SavedPaneDirs | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('vscodeFiler');
    const showDotFiles = config.get<boolean>('showDotFiles', true);
    this.keybindings = mergeKeybindings(config.get<Record<string, unknown>>('keybindings'));

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.fallbackDir = workspaceRoot || os.homedir();

    const savedDirs = this.context.globalState.get<Partial<SavedPaneDirs>>(LAST_PANE_DIRS_KEY);
    const leftDir = savedDirs?.left || this.fallbackDir;
    const rightDir = savedDirs?.right || this.fallbackDir;
    if (savedDirs?.left && savedDirs?.right) {
      this.lastSavedDirs = { left: savedDirs.left, right: savedDirs.right };
    }

    this.paneManager = new PaneManager(leftDir, rightDir, showDotFiles);
    this.logger = new OperationLogger(500);
    this.fileOps = new FileOperations(this.logger, {
      confirmOverwrite: async (targetPath: string) => {
        return this.confirmModal(
          `Overwrite existing "${path.basename(targetPath)}"?`,
          'Overwrite'
        );
      },
      moveToTrash: async (targetPath: string) => {
        await vscode.workspace.fs.delete(vscode.Uri.file(targetPath), {
          recursive: true,
          useTrash: true,
        });
      },
    });

    this.logger.setListeners(
      (entry) => this.postMessage({ type: 'log', entry }),
      () => this.postMessage({ type: 'clearLogs' })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vscodeFiler.keybindings')) {
          const updated = vscode.workspace.getConfiguration('vscodeFiler');
          this.keybindings = mergeKeybindings(updated.get<Record<string, unknown>>('keybindings'));
          this.syncState();
        }
      })
    );
  }

  public async open(): Promise<void> {
    await this.closeSideBars();

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'vscodeFiler',
      'VS Code Filer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(
      () => {
        this.persistPaneDirs();
        this.panel = undefined;
      },
      null,
      this.disposables
    );

    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active && Date.now() >= this.suppressFocusUntil) {
          this.postMessage({ type: 'focus' });
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => {
        void this.handleMessage(msg);
      },
      null,
      this.disposables
    );

    await this.ensureValidPaneDirs();
    await this.paneManager.reloadAll();
    this.logger.info(`Filer opened. Left: ${this.paneManager.getPane(0).cwd} | Right: ${this.paneManager.getPane(1).cwd}`);
  }

  private async ensureValidPaneDirs(): Promise<void> {
    const panes = this.paneManager.getPanes();
    for (const pane of panes) {
      if (!(await this.isExistingDirectory(pane.cwd))) {
        await this.paneManager.cd(pane.id, this.fallbackDir, false);
      }
    }
  }

  private async isExistingDirectory(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private persistPaneDirs(): void {
    const [left, right] = this.paneManager.getPanes();
    if (
      this.lastSavedDirs &&
      this.lastSavedDirs.left === left.cwd &&
      this.lastSavedDirs.right === right.cwd
    ) {
      return;
    }
    this.lastSavedDirs = { left: left.cwd, right: right.cwd };
    void this.context.globalState.update(LAST_PANE_DIRS_KEY, this.lastSavedDirs);
  }

  private async closeSideBars(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('workbench.action.closeSidebar').then(undefined, () => { }),
      vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => { }),
    ]);
  }

  private postMessage(msg: ExtensionToWebviewMessage): void {
    this.panel?.webview.postMessage(msg);
  }

  private restoreFocus(): void {
    if (!this.panel) {
      return;
    }
    this.panel.reveal(this.panel.viewColumn, false);
    setTimeout(() => {
      this.postMessage({ type: 'focus' });
    }, 50);
  }

  private async confirmModal(message: string, confirmLabel: string): Promise<boolean> {
    try {
      const answer = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel
      );
      return answer === confirmLabel;
    } finally {
      this.restoreFocus();
    }
  }

  private async promptInput(options: vscode.InputBoxOptions): Promise<string | undefined> {
    try {
      return await vscode.window.showInputBox(options);
    } finally {
      this.restoreFocus();
    }
  }

  private async promptQuickPick<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: vscode.QuickPickOptions
  ): Promise<T | undefined> {
    try {
      return await vscode.window.showQuickPick(items, options);
    } finally {
      this.restoreFocus();
    }
  }

  private syncState(): void {
    this.persistPaneDirs();
    this.postMessage({
      type: 'state',
      state: {
        panes: this.paneManager.getPanes(),
        activePane: this.paneManager.getActivePaneId(),
        logs: this.logger.getLogs(),
        keybindings: this.keybindings,
      },
    });
  }

  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.paneManager.reloadAll();
        this.syncState();
        return;

      case 'selectPane':
        this.paneManager.setActivePane(msg.paneId);
        this.syncState();
        return;

      case 'selectEntry':
        this.paneManager.setActivePane(msg.paneId);
        this.paneManager.setCursor(msg.paneId, msg.index);
        if (msg.open) {
          await this.handleEnter();
        } else {
          this.syncState();
        }
        return;

      case 'action':
        await this.handleAction(msg.action, msg.args);
        return;

      case 'promptResult':
        await this.handlePromptResult(msg.action, msg.value);
        return;
    }
  }

  private async handleAction(action: string, args?: Record<string, unknown>): Promise<void> {
    const activeId = this.paneManager.getActivePaneId();
    const activePane = this.paneManager.getActivePane();
    const otherPane = this.paneManager.getInactivePane();

    try {
      switch (action) {
        case 'cursorUp':
          this.paneManager.moveCursor(activeId, -1);
          this.syncState();
          return;
        case 'cursorDown':
          this.paneManager.moveCursor(activeId, 1);
          this.syncState();
          return;
        case 'cursorTop':
          this.paneManager.cursorTop(activeId);
          this.syncState();
          return;
        case 'cursorBottom':
          this.paneManager.cursorBottom(activeId);
          this.syncState();
          return;
        case 'pageUp':
          this.paneManager.moveCursor(activeId, -10);
          this.syncState();
          return;
        case 'pageDown':
          this.paneManager.moveCursor(activeId, 10);
          this.syncState();
          return;
        case 'paneLeft':
          if (activeId !== 0) {
            this.paneManager.setActivePane(0);
            this.syncState();
          }
          return;
        case 'paneRight':
          if (activeId !== 1) {
            this.paneManager.setActivePane(1);
            this.syncState();
          }
          return;
        case 'switchPane':
          this.paneManager.switchPane();
          this.syncState();
          return;
        case 'enter':
          await this.handleEnter();
          return;
        case 'preview':
          await this.handlePreview();
          return;
        case 'parentDir':
          await this.paneManager.parentDir(activeId);
          this.syncState();
          return;
        case 'rootDir':
          await this.paneManager.cd(activeId, path.parse(activePane.cwd).root);
          this.syncState();
          return;
        case 'homeDir':
          await this.paneManager.cd(activeId, os.homedir());
          this.syncState();
          return;
        case 'toggleMark':
          this.paneManager.toggleMarkAndMoveDown(activeId);
          this.syncState();
          return;
        case 'rangeMarkStart':
          this.paneManager.setRangeMarkStart(activeId);
          this.logger.info('Range mark start set.');
          return;
        case 'rangeMarkEnd': {
          const count = this.paneManager.applyRangeMarkEnd(activeId);
          this.logger.info(`Range mark toggled ${count} item(s).`);
          this.syncState();
          return;
        }
        case 'invertFileMarks':
          this.paneManager.invertMarks(activeId, true);
          this.syncState();
          return;
        case 'invertAllMarks':
          this.paneManager.invertMarks(activeId, false);
          this.syncState();
          return;
        case 'globMark': {
          const pattern = await this.promptInput({
            prompt: 'Glob pattern to mark (e.g. *.ts)',
            placeHolder: '*.ts',
          });
          if (pattern) {
            const count = this.paneManager.markByGlob(activeId, pattern);
            this.logger.info(`Glob mark "${pattern}": toggled ${count} item(s).`);
            this.syncState();
          }
          return;
        }
        case 'regexMark': {
          const pattern = await this.promptInput({
            prompt: 'RegExp pattern to mark',
            placeHolder: '\\.test\\.ts$',
          });
          if (pattern) {
            try {
              const count = this.paneManager.markByRegex(activeId, pattern);
              this.logger.info(`Regex mark /${pattern}/: toggled ${count} item(s).`);
              this.syncState();
            } catch (err) {
              this.logger.error(`Invalid RegExp: ${String(err)}`);
            }
          }
          return;
        }
        case 'toggleDotFiles': {
          const shown = await this.paneManager.toggleDotFiles(activeId);
          this.logger.info(`Dotfiles: ${shown ? 'SHOWN' : 'HIDDEN'}`);
          this.syncState();
          return;
        }
        case 'copy': {
          const targets = this.paneManager.getTargetEntries(activeId);
          if (targets.length === 0) {
            return;
          }
          await this.fileOps.copyEntries(targets, otherPane.cwd);
          await this.paneManager.reloadAll();
          this.syncState();
          return;
        }
        case 'move': {
          const targets = this.paneManager.getTargetEntries(activeId);
          if (targets.length === 0) {
            return;
          }
          await this.fileOps.moveEntries(targets, otherPane.cwd);
          await this.paneManager.reloadAll();
          this.syncState();
          return;
        }
        case 'trash': {
          const targets = this.paneManager.getTargetEntries(activeId);
          if (targets.length === 0) {
            return;
          }
          const ok = await this.confirmModal(
            `Move ${targets.length} item(s) to Trash?`,
            'Move to Trash'
          );
          if (ok) {
            await this.fileOps.trashEntries(targets);
            await this.paneManager.reloadAll();
            this.syncState();
          }
          return;
        }
        case 'deletePermanent': {
          const targets = this.paneManager.getTargetEntries(activeId);
          if (targets.length === 0) {
            return;
          }
          const confirm = vscode.workspace
            .getConfiguration('vscodeFiler')
            .get<boolean>('confirmPermanentDelete', true);
          if (confirm) {
            const ok = await this.confirmModal(
              `PERMANENTLY delete ${targets.length} item(s)? This cannot be undone.`,
              'Delete Permanently'
            );
            if (!ok) {
              return;
            }
          }
          await this.fileOps.deletePermanentEntries(targets);
          await this.paneManager.reloadAll();
          this.syncState();
          return;
        }
        case 'symlink': {
          const targets = this.paneManager.getTargetEntries(activeId);
          if (targets.length === 0) {
            return;
          }
          await this.fileOps.createSymlinks(targets, otherPane.cwd);
          await this.paneManager.reloadAll();
          this.syncState();
          return;
        }
        case 'rename':
          await this.handleRename(activeId);
          return;
        case 'newFile': {
          const name = await this.promptInput({
            prompt: 'New file name',
            placeHolder: 'example.txt',
          });
          if (name) {
            await this.fileOps.createFile(activePane.cwd, name);
            await this.paneManager.reloadPane(activeId, path.basename(name));
            this.syncState();
          }
          return;
        }
        case 'newDir': {
          const name = await this.promptInput({
            prompt: 'New directory name (supports nested paths like a/b/c)',
            placeHolder: 'new_folder',
          });
          if (name) {
            await this.fileOps.makeDirectory(activePane.cwd, name);
            await this.paneManager.reloadPane(activeId, name.split('/')[0]);
            this.syncState();
          }
          return;
        }
        case 'compressToOther':
        case 'compressHere': {
          const targets = this.paneManager.getTargetEntries(activeId);
          if (targets.length === 0) {
            return;
          }
          const destDir = action === 'compressToOther' ? otherPane.cwd : activePane.cwd;
          const defaultArchive = `${path.basename(targets[0].name)}.tar.gz`;
          const archiveName = await this.promptInput({
            prompt: `Archive file name (dest: ${destDir})`,
            value: defaultArchive,
          });
          if (archiveName) {
            const archivePath = path.resolve(destDir, archiveName);
            await this.fileOps.compressEntries(targets, activePane.cwd, archivePath);
            await this.paneManager.reloadAll();
            this.syncState();
          }
          return;
        }
        case 'extractToOther':
        case 'extractHere': {
          const entry = this.paneManager.getCursorEntry(activeId);
          if (!entry || entry.isDirectory || entry.name === '..') {
            return;
          }
          const destDir = action === 'extractToOther' ? otherPane.cwd : activePane.cwd;
          await this.fileOps.extractArchive(entry.path, destDir);
          await this.paneManager.reloadAll();
          this.syncState();
          return;
        }
        case 'sortMenu':
          await this.handleSortMenu(activeId);
          return;
        case 'maskMenu': {
          const mask = await this.promptInput({
            prompt: 'File mask glob (empty to clear)',
            value: activePane.mask,
            placeHolder: '*.ts',
          });
          if (mask !== undefined) {
            await this.paneManager.setMask(activeId, mask);
            this.logger.info(`Mask (${activeId === 0 ? 'Left' : 'Right'}): ${mask || '(none)'}`);
            this.syncState();
          }
          return;
        }
        case 'syncActiveToOther':
          await this.paneManager.syncActiveToOther();
          this.logger.info(`Synced other pane to ${activePane.cwd}`);
          this.syncState();
          return;
        case 'syncOtherToActive':
          await this.paneManager.syncOtherToActive();
          this.logger.info(`Synced active pane to ${otherPane.cwd}`);
          this.syncState();
          return;
        case 'swapPanes':
          await this.paneManager.swapPanes();
          this.logger.info('Swapped left and right panes.');
          this.syncState();
          return;
        case 'findVirtualDir': {
          const pattern = await this.promptInput({
            prompt: `Find files in ${activePane.cwd} (glob pattern)`,
            placeHolder: '*.ts',
          });
          if (pattern !== undefined) {
            this.logger.info(`Searching files matching "${pattern || '*'}"...`);
            const results = await findEntries(activePane.cwd, pattern);
            this.paneManager.setVirtualEntries(activeId, `[FIND: ${pattern || '*'}]`, results);
            this.logger.success(`Find completed: ${results.length} item(s).`);
            this.syncState();
          }
          return;
        }
        case 'grepVirtualDir': {
          const query = await this.promptInput({
            prompt: `Grep file contents in ${activePane.cwd} (RegExp / text)`,
            placeHolder: 'search term',
          });
          if (query) {
            this.logger.info(`Grepping "${query}"...`);
            const results = await grepEntries(activePane.cwd, query);
            this.paneManager.setVirtualEntries(activeId, `[GREP: ${query}]`, results);
            this.logger.success(`Grep completed: ${results.length} matching file(s).`);
            this.syncState();
          }
          return;
        }
        case 'jumpMenu':
          await this.handleJumpMenu(activeId);
          return;
        case 'driveMenu':
          await this.handleDriveMenu(activeId);
          return;
        case 'goToPath':
          await this.handleGoToPath(activeId);
          return;
        case 'historyMenu':
          await this.handleHistoryMenu(activeId);
          return;
        case 'historyBack':
          if (await this.paneManager.historyBack(activeId)) {
            this.syncState();
          }
          return;
        case 'historyForward':
          if (await this.paneManager.historyForward(activeId)) {
            this.syncState();
          }
          return;
        case 'openTerminal': {
          const wslInfo = parseWslUncPath(activePane.cwd);
          const terminal = wslInfo
            ? vscode.window.createTerminal({
                name: `WSL (${wslInfo.distro}): ${wslInfo.linuxPath}`,
                shellPath: 'wsl.exe',
                shellArgs: ['-d', wslInfo.distro, '--cd', wslInfo.linuxPath],
              })
            : vscode.window.createTerminal({
                name: `Filer: ${path.basename(activePane.cwd) || activePane.cwd}`,
                cwd: activePane.cwd,
              });
          terminal.show();
          this.logger.info(`Opened terminal at ${activePane.cwd}`);
          return;
        }
        case 'refresh':
          await this.paneManager.reloadAll();
          this.logger.info('Refreshed panes.');
          this.syncState();
          return;
        case 'clearLog':
          this.logger.clear();
          return;
        case 'jumpToIndex':
          if (typeof args?.index === 'number') {
            this.paneManager.setCursor(activeId, args.index);
            this.syncState();
          }
          return;
      }
    } catch (err) {
      this.logger.error(`Action "${action}" failed: ${String(err)}`);
    }
  }

  private async handlePromptResult(_action: string, _value: string | null): Promise<void> {
    // Reserved for future inline minibuffer prompts
  }

  private async handleEnter(): Promise<void> {
    const activeId = this.paneManager.getActivePaneId();
    const entry = this.paneManager.getCursorEntry(activeId);
    if (!entry) {
      return;
    }

    if (entry.name === '..') {
      await this.paneManager.parentDir(activeId);
      this.syncState();
      return;
    }

    if (entry.isDirectory) {
      await this.paneManager.cd(activeId, entry.path);
      this.syncState();
      return;
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.path));
    await vscode.window.showTextDocument(doc, { preview: false });
    this.logger.info(`OPEN: ${entry.path}`);
  }

  private async handlePreview(): Promise<void> {
    const activeId = this.paneManager.getActivePaneId();
    const entry = this.paneManager.getCursorEntry(activeId);
    if (!entry) {
      return;
    }

    if (entry.name === '..' || entry.isDirectory) {
      return;
    }

    const bdfExt = vscode.extensions.getExtension('bdf.bdf-preview');
    if (!bdfExt) {
      const msg =
        'Extension "BDF Document Preview for Visual Studio Code" (bdf.bdf-preview) is not installed.';
      this.logger.warn(msg);
      void vscode.window.showWarningMessage(msg);
      return;
    }

    const previewToSide = vscode.workspace
      .getConfiguration('vscodeFiler')
      .get<boolean>('previewToSide', true);
    const command = previewToSide ? 'bdf.openPreviewToSide' : 'bdf.openPreview';

    try {
      const uri = vscode.Uri.file(entry.path);
      this.suppressFocusUntil = Date.now() + 500;
      await vscode.commands.executeCommand(command, uri);
      if (
        previewToSide &&
        vscode.window.tabGroups.activeTabGroup.viewColumn === this.panel?.viewColumn
      ) {
        await vscode.commands.executeCommand('workbench.action.focusRightGroup');
      }
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      this.logger.info(`PREVIEW: ${entry.path}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to preview ${entry.name}: ${errMsg}`);
      void vscode.window.showErrorMessage(
        `Failed to preview file with BDF Document Preview: ${errMsg}`
      );
    }
  }

  private async handleRename(activeId: PaneId): Promise<void> {
    const pane = this.paneManager.getPane(activeId);
    const marked = pane.entries.filter((e) => e.marked && e.name !== '..');

    if (marked.length > 0) {
      const pattern = await this.promptInput({
        prompt: `Regex Rename (${marked.length} marked files) - Search RegExp`,
        placeHolder: '\\.js$',
      });
      if (!pattern) {
        return;
      }
      const replacement = await this.promptInput({
        prompt: `Regex Rename - Replacement for /${pattern}/`,
        placeHolder: '.ts',
      });
      if (replacement === undefined) {
        return;
      }
      await this.fileOps.regexRenameEntries(marked, pattern, replacement);
      await this.paneManager.reloadPane(activeId);
      this.syncState();
      return;
    }

    const current = this.paneManager.getCursorEntry(activeId);
    if (!current || current.name === '..') {
      return;
    }
    const newName = await this.promptInput({
      prompt: `Rename "${current.name}"`,
      value: current.name,
    });
    if (newName && newName !== current.name) {
      await this.fileOps.renameEntry(current, newName);
      await this.paneManager.reloadPane(activeId, newName);
      this.syncState();
    }
  }

  private async handleSortMenu(activeId: PaneId): Promise<void> {
    const options: Array<{ label: string; field: SortField; order: SortOrder }> = [
      { label: 'Name (Ascending)', field: 'name', order: 'asc' },
      { label: 'Name (Descending)', field: 'name', order: 'desc' },
      { label: 'Size (Largest first)', field: 'size', order: 'desc' },
      { label: 'Size (Smallest first)', field: 'size', order: 'asc' },
      { label: 'Modified Time (Newest first)', field: 'mtime', order: 'desc' },
      { label: 'Modified Time (Oldest first)', field: 'mtime', order: 'asc' },
      { label: 'Extension (Ascending)', field: 'ext', order: 'asc' },
      { label: 'Extension (Descending)', field: 'ext', order: 'desc' },
    ];
    const picked = await this.promptQuickPick(options, {
      placeHolder: 'Select sort order',
    });
    if (picked) {
      await this.paneManager.setSort(activeId, picked.field, picked.order);
      this.logger.info(`Sort: ${picked.label}`);
      this.syncState();
    }
  }

  private async handleJumpMenu(activeId: PaneId): Promise<void> {
    const activePane = this.paneManager.getPane(activeId);
    const bookmarks = this.context.globalState.get<string[]>(JUMP_BOOKMARKS_KEY, []);

    const items: Array<vscode.QuickPickItem & { kindType: 'add' | 'clear' | 'jump'; path?: string }> = [
      {
        label: '$(plus) Add current directory to bookmarks',
        description: activePane.cwd,
        kindType: 'add',
      },
      ...bookmarks.map((b) => ({
        label: `$(folder) ${path.basename(b) || b}`,
        description: b,
        kindType: 'jump' as const,
        path: b,
      })),
    ];

    if (bookmarks.length > 0) {
      items.push({
        label: '$(trash) Clear all bookmarks',
        kindType: 'clear',
      });
    }

    const picked = await this.promptQuickPick(items, {
      placeHolder: 'Jump to bookmarked directory',
    });
    if (!picked) {
      return;
    }

    if (picked.kindType === 'add') {
      if (!bookmarks.includes(activePane.cwd)) {
        const updated = [...bookmarks, activePane.cwd];
        await this.context.globalState.update(JUMP_BOOKMARKS_KEY, updated);
        this.logger.success(`Bookmarked: ${activePane.cwd}`);
      }
    } else if (picked.kindType === 'clear') {
      await this.context.globalState.update(JUMP_BOOKMARKS_KEY, []);
      this.logger.info('Cleared all jump bookmarks.');
    } else if (picked.kindType === 'jump' && picked.path) {
      await this.cdWithUncPrompt(activeId, picked.path);
      this.syncState();
    }
  }

  private async cdWithUncPrompt(paneId: PaneId, targetPath: string): Promise<void> {
    try {
      await this.paneManager.cd(paneId, targetPath);
    } catch (err) {
      if (!isUncNotAllowedError(err)) {
        throw err;
      }

      const host = extractUncHost(targetPath);
      if (!host) {
        throw err;
      }

      const choice = await vscode.window.showWarningMessage(
        `UNC host "${host}" is blocked by VS Code's security setting (security.allowedUNCHosts). Add "${host}" to allowed hosts?`,
        { modal: true },
        'Allow Host'
      );
      this.restoreFocus();

      if (choice !== 'Allow Host') {
        throw err;
      }

      const securityConfig = vscode.workspace.getConfiguration('security');
      const current = securityConfig.get<string[]>('allowedUNCHosts', []);
      if (!current.some((h) => h.toLowerCase() === host.toLowerCase())) {
        await securityConfig.update(
          'allowedUNCHosts',
          [...current, host],
          vscode.ConfigurationTarget.Global
        );
        this.logger.info(`Added "${host}" to security.allowedUNCHosts.`);
      }

      try {
        await this.paneManager.cd(paneId, targetPath);
      } catch (retryErr) {
        if (isUncNotAllowedError(retryErr)) {
          const reload = await vscode.window.showInformationMessage(
            `"${host}" was added to security.allowedUNCHosts. Reload the window to apply the change.`,
            'Reload Window'
          );
          if (reload === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
          return;
        }
        throw retryErr;
      }
    }
  }

  private getLocationIcon(kind: DriveEntry['kind']): string {
    switch (kind) {
      case 'wsl':
        return '$(terminal)';
      case 'network':
        return '$(remote)';
      case 'local':
        return '$(device-desktop)';
      default:
        return '$(folder)';
    }
  }

  private async handleDriveMenu(activeId: PaneId): Promise<void> {
    const locations = await listAvailableLocations();

    type DrivePickItem = vscode.QuickPickItem & {
      kindType: 'input' | 'location';
      targetPath?: string;
    };

    const items: DrivePickItem[] = [
      {
        label: '$(edit) Enter path manually (Drive / UNC / WSL)...',
        description: 'e.g. Z:\\, \\\\server\\share, \\\\wsl.localhost\\Ubuntu\\home',
        kindType: 'input',
      },
      ...locations.map((loc) => ({
        label: `${this.getLocationIcon(loc.kind)} ${loc.label}`,
        description: loc.detail && loc.detail !== loc.path ? `${loc.path} (${loc.detail})` : loc.path,
        kindType: 'location' as const,
        targetPath: loc.path,
      })),
    ];

    const picked = await this.promptQuickPick(items, {
      placeHolder: 'Select drive, network share, or WSL distribution',
    });
    if (!picked) {
      return;
    }

    if (picked.kindType === 'input') {
      await this.handleGoToPath(activeId);
      return;
    }

    if (picked.targetPath) {
      await this.cdWithUncPrompt(activeId, picked.targetPath);
      this.logger.info(`Changed location: ${picked.targetPath}`);
      this.syncState();
    }
  }

  private async handleGoToPath(activeId: PaneId): Promise<void> {
    const activePane = this.paneManager.getPane(activeId);
    const input = await this.promptInput({
      prompt: 'Go to directory (Drive, UNC network path, or WSL path)',
      value: activePane.cwd,
      placeHolder: 'D:\\Projects, \\\\server\\share, \\\\wsl.localhost\\Ubuntu\\home',
    });
    if (!input) {
      return;
    }
    const targetPath = normalizeInputPath(input, activePane.cwd);
    await this.cdWithUncPrompt(activeId, targetPath);
    this.logger.info(`CD: ${targetPath}`);
    this.syncState();
  }

  private async handleHistoryMenu(activeId: PaneId): Promise<void> {
    const pane = this.paneManager.getPane(activeId);
    const items = [...pane.history]
      .reverse()
      .map((dirPath) => ({ label: path.basename(dirPath) || dirPath, description: dirPath }));

    const picked = await this.promptQuickPick(items, {
      placeHolder: 'Directory history',
    });
    if (picked && picked.description) {
      await this.cdWithUncPrompt(activeId, picked.description);
      this.syncState();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>VS Code Filer</title>
  <style>
    :root {
      --filer-border: var(--vscode-panel-border, #444);
      --filer-active-border: var(--vscode-focusBorder, #007acc);
      --filer-bg: var(--vscode-editor-background, #1e1e1e);
      --filer-fg: var(--vscode-editor-foreground, #cccccc);
      --filer-header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
      --filer-cursor-bg: var(--vscode-list-activeSelectionBackground, #094771);
      --filer-cursor-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
      --filer-inactive-cursor-bg: var(--vscode-list-inactiveSelectionBackground, #37373d);
      --filer-mark-color: var(--vscode-editorWarning-foreground, #cca700);
      --filer-dir-color: var(--vscode-textLink-foreground, #4fc1ff);
      --filer-link-color: var(--vscode-charts-purple, #c586c0);
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--filer-bg);
      color: var(--filer-fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      overflow: hidden;
      user-select: none;
    }

    .root {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      outline: none;
    }

    .dir-panes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      flex: 1 1 auto;
      min-height: 0;
      gap: 4px;
      padding: 4px;
    }

    .pane {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--filer-border);
      min-height: 0;
      min-width: 0;
    }

    .pane.active {
      border-color: var(--filer-active-border);
    }

    .pane-header {
      background: var(--filer-header-bg);
      padding: 4px 8px;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--filer-border);
      white-space: nowrap;
      overflow: hidden;
    }

    .pane.active .pane-header {
      border-bottom-color: var(--filer-active-border);
    }

    .pane-path {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pane-meta {
      font-size: 11px;
      opacity: 0.8;
      margin-left: 8px;
      flex-shrink: 0;
    }

    .pane-list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 2px 0;
    }

    .entry-row {
      display: grid;
      grid-template-columns: 18px 1fr 80px 110px;
      padding: 1px 6px;
      cursor: pointer;
      white-space: nowrap;
      align-items: center;
    }

    .entry-row.cursor.pane-active {
      background: var(--filer-cursor-bg);
      color: var(--filer-cursor-fg);
    }

    .entry-row.cursor:not(.pane-active) {
      background: var(--filer-inactive-cursor-bg);
    }

    .entry-row.marked {
      color: var(--filer-mark-color);
      font-weight: bold;
    }

    .entry-row.cursor.pane-active.marked {
      color: var(--filer-cursor-fg);
    }

    .entry-mark {
      text-align: center;
      color: var(--filer-mark-color);
      font-weight: bold;
    }

    .entry-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .entry-name.is-dir {
      color: var(--filer-dir-color);
      font-weight: 600;
    }

    .entry-name.is-link {
      color: var(--filer-link-color);
    }

    .entry-row.cursor.pane-active .entry-name.is-dir,
    .entry-row.cursor.pane-active .entry-name.is-link {
      color: var(--filer-cursor-fg);
    }

    .entry-size {
      text-align: right;
      padding-right: 8px;
      opacity: 0.85;
    }

    .entry-date {
      text-align: right;
      opacity: 0.75;
      font-size: 11px;
    }

    .log-pane {
      height: 160px;
      min-height: 90px;
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--filer-border);
      margin: 0 4px 4px 4px;
      border: 1px solid var(--filer-border);
    }

    .log-header {
      background: var(--filer-header-bg);
      padding: 2px 8px;
      font-size: 11px;
      font-weight: bold;
      border-bottom: 1px solid var(--filer-border);
      display: flex;
      justify-content: space-between;
    }

    .log-list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px 8px;
      font-size: 12px;
      line-height: 1.4;
      user-select: text;
    }

    .log-line.info { opacity: 0.9; }
    .log-line.success { color: var(--vscode-testing-iconPassed, #73c991); }
    .log-line.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
    .log-line.error { color: var(--vscode-errorForeground, #f48771); }

    .status-bar {
      background: var(--vscode-statusBar-background, #007acc);
      color: var(--vscode-statusBar-foreground, #ffffff);
      padding: 3px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      gap: 12px;
    }

    .search-box {
      display: none;
      align-items: center;
      gap: 6px;
      flex: 1;
    }

    .search-box.active {
      display: flex;
    }

    .search-box input {
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-focusBorder, #007acc);
      padding: 1px 6px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
      width: 260px;
    }

    .help-overlay {
      display: none;
      position: fixed;
      inset: 24px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--filer-active-border);
      z-index: 100;
      flex-direction: column;
      padding: 12px 16px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .help-overlay.open {
      display: flex;
    }

    .help-title {
      font-weight: bold;
      font-size: 14px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
    }

    .help-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
      gap: 4px 16px;
      overflow-y: auto;
      font-size: 12px;
    }

    .help-item {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid rgba(128, 128, 128, 0.15);
      padding: 2px 0;
    }

    .help-keys {
      color: var(--filer-dir-color);
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="root" tabindex="-1">
    <div class="dir-panes">
      <div class="pane" id="pane-0">
        <div class="pane-header">
          <span class="pane-path" id="pane-0-path"></span>
          <span class="pane-meta" id="pane-0-meta"></span>
        </div>
        <div class="pane-list" id="pane-0-list"></div>
      </div>
      <div class="pane" id="pane-1">
        <div class="pane-header">
          <span class="pane-path" id="pane-1-path"></span>
          <span class="pane-meta" id="pane-1-meta"></span>
        </div>
        <div class="pane-list" id="pane-1-list"></div>
      </div>
    </div>

    <div class="log-pane">
      <div class="log-header">
        <span>Operation Log</span>
        <span>Press ? for Help | Ctrl+K to Clear Log</span>
      </div>
      <div class="log-list" id="log-list"></div>
    </div>

    <div class="status-bar">
      <div class="search-box" id="search-box">
        <span>ISearch:</span>
        <input type="text" id="search-input" placeholder="Type filename..." />
        <span id="search-hint">(Enter/Esc to close, ↑/↓ next/prev)</span>
      </div>
      <span id="status-left">Ready</span>
      <span id="status-right"></span>
    </div>
  </div>

  <div class="help-overlay" id="help-overlay">
    <div class="help-title">
      <span>VS Code Filer — Keybindings (Customizable via vscodeFiler.keybindings)</span>
      <span>Press Esc or ? to close</span>
    </div>
    <div class="help-grid" id="help-grid"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    this.panel?.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
