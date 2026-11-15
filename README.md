# VS Code Filer

A 3-pane keyboard-driven filer extension for VS Code inspired by `mfiler4`.

## Features

- **3-Pane Layout**:
  - **Left & Right Panes**: Dual directory panes for fast navigation and cross-pane operations.
  - **Bottom Pane**: Real-time operation log output.
- **mfiler4-inspired Keybindings**:
  - Cursor navigation (`ArrowUp/Down`, `Ctrl+P/N`, `PageUp/Down`, `Ctrl+A/E`), pane switching (`ArrowLeft/Right`, `Ctrl+B/F`, `Tab`).
  - File marking (`Space`, `[`/`]`, `Home`/`End`, `*` glob, `+` regex).
  - File operations (`c` copy, `m` move, `d` trash, `D` permanent delete, `l` symlink, `r` rename / regex rename, `k` mkdir, `n` new file, `p`/`u` compress & extract).
  - Preview (`v` open document preview via BDF Document Preview).
  - Virtual directories (`F` find, `G` grep), incremental search (`/` or `f`), bookmarks (`j`), history (`h`, `Alt+L`/`Alt+R`), terminal (`:`).
- **Customizable Keybindings**:
  - Override any keybinding via `vscodeFiler.keybindings` in VS Code settings.

## Usage

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **VS Code Filer: Open**.
3. Press `?` inside the filer to view all active keybindings.

