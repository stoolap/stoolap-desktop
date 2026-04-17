<div align="center">
  <img src="src-tauri/icons/icon.png" alt="Stoolap Desktop" width="120">

  <h1>Stoolap Desktop</h1>

  <p>Native desktop database manager for <a href="https://github.com/stoolap/stoolap">Stoolap</a>.</p>

  <p>
    <a href="https://github.com/stoolap/stoolap-desktop/actions/workflows/ci.yml"><img src="https://github.com/stoolap/stoolap-desktop/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/stoolap/stoolap-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/stoolap/stoolap-desktop" alt="Latest release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platforms">
  </p>
</div>

---

Stoolap Desktop is a lightweight native database client for the [Stoolap](https://github.com/stoolap/stoolap) embedded SQL engine. It embeds the Rust engine directly — no server, no bundled Chromium, no Node runtime — so the app stays under 15 MB and talks to your database at in-process speed.

Built with [Tauri 2](https://v2.tauri.app/) (Rust backend + WebKit/WebView2 frontend) and React.

## Why Stoolap Desktop?

- **Truly native** — Tauri wraps the system WebView; the whole app is ~12 MB binary + 5 MB DMG instead of the 100+ MB a typical Electron database client ships.
- **In-process engine** — `stoolap` is linked as a Rust crate. There is no IPC to a driver, no "connector" to misconfigure, and transactions run at the same latency the underlying engine gives you.
- **Full Stoolap feature surface** — time-travel queries (`AS OF TIMESTAMP`), HNSW vector search, multi-column indexes, MVCC transactions, and rich DDL are first-class in the UI, not bolted on.
- **Native feel on macOS** — overlay title bar, system accent color, system appearance follows light/dark, native context menus and file dialogs.
- **Auto-update built in** — code-signed updater ships new versions over a GitHub Releases feed.

## Screenshots

> *(add screenshots here: SQL editor, data grid, vector search dialog, schema tree)*

## Features

### SQL Editor
- Multi-tab CodeMirror editor with a Stoolap SQL dialect (keywords, types, built-in functions)
- Schema-aware autocomplete (table and column names)
- Execute with `Cmd/Ctrl+Enter`; run `EXPLAIN` with `Cmd/Ctrl+E`
- Multi-statement execution with automatic `BEGIN`/`COMMIT` wrapping for DML, preserving open transactions across runs
- Query history per session

### Schema Browser
- Sidebar tree of every table and view with filter
- Expandable columns (type, PK, FK, nullability, default), indexes, foreign keys
- Row counts per table
- Right-click actions: View Data, `SELECT *`, Show DDL, Insert Row, Create Index, Alter, Truncate, Drop
- FK indicators with one-click navigation into the referenced row

### Data Viewer
- Virtualized grid (hundreds of thousands of rows without lag)
- Column sorting (server-side), resizing, and in-grid search
- Inline cell editing, row insertion and deletion
- Filter panel with `=`, `!=`, `>`, `<`, `LIKE`, `IN`, `IS NULL`, and vector-distance operators
- Time travel: run queries at any point in the table's history via `AS OF TIMESTAMP`
- Export current page or the entire (filtered) table to CSV / JSON — streamed straight to disk so multi-GB tables don't OOM the UI
- CSV / JSON import via the engine's `COPY FROM` (no client-side batching)

### Vector Database
- `VECTOR(N)` columns with dimension presets (128 – 1536)
- HNSW index creation with configurable `m`, `ef_construction`, and distance metric (`cosine`, `l2`, `ip`)
- Dedicated Vector Search dialog: pick a table + column, paste or pick a query vector, set `k`, add `WHERE` filters, preview the generated SQL, run inline
- Distance columns auto-detected in results with color-gradient bars
- Vector cells abbreviated in the grid; click to expand into a dimension-by-dimension heatmap

### Index Management
- Create standard (BTree, Hash, Bitmap) or HNSW indexes via dialog
- Multi-column indexes, `UNIQUE` option, named constraints
- k-NN search template generation from any HNSW index

### Table & View Management
- Create tables with a visual dialog: column types, constraints (`PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `AUTO_INCREMENT`, `CHECK`), foreign keys with `ON DELETE` / `ON UPDATE` actions, and defaults
- Alter tables (add / modify / drop columns)
- Create and drop views
- DDL preview before any destructive action

### Backup & Restore
- One-shot SQL dump export — tables, data, views, indexes, `DROP IF EXISTS` guards, FK-dependency-ordered
- Streams chunks directly to disk; safe for databases larger than RAM
- Restore from any SQL dump with per-statement progress and optional transaction wrapping
- HNSW index parameters (`metric`, `m`, `ef_construction`) are preserved in the backup and re-applied on restore

### Native Integration
- macOS: overlay title bar with hidden title, system accent color live-tracked, native context menus, proper app menu with `About`, `Check for Updates…`, services submenu, quit
- System notifications on long-running operations (backup complete, export finished, import complete)
- Native file / folder dialogs via the OS picker
- Window state persistence — size, position, and maximized state restore on next launch
- Single-process: the engine is linked in, not spawned

### Theming & Accessibility
- Follows system light / dark appearance
- Accent color pulled from the OS (macOS `NSColor.controlAccentColor`)
- Keyboard navigation throughout; full shortcut sheet via `Cmd/Ctrl + ?`

### Auto-Update
- Bundled `tauri-plugin-updater` checks a signed `latest.json` feed on GitHub Releases
- User sees a dialog with the version, release notes, progress bar, and "Install & Restart"
- Every update bundle is ed25519-signed with the maintainer's private key; the app refuses to install anything that doesn't verify against the public key baked into the binary

## Installation

### macOS

Download `Stoolap Desktop_<version>_aarch64.dmg` (Apple Silicon) or `…_x64.dmg` (Intel) from the [latest release](https://github.com/stoolap/stoolap-desktop/releases/latest), open the DMG, and drag Stoolap Desktop to `/Applications`.

If the app isn't notarized yet, right-click → **Open** the first time to bypass Gatekeeper.

### Linux

Download the `.AppImage` (portable) or `.deb` (for Debian / Ubuntu) from the [latest release](https://github.com/stoolap/stoolap-desktop/releases/latest).

```sh
# AppImage
chmod +x "Stoolap Desktop_*.AppImage"
./"Stoolap Desktop_*.AppImage"

# .deb
sudo dpkg -i stoolap-desktop_*_amd64.deb
```

### Windows

Download the `.msi` installer from the [latest release](https://github.com/stoolap/stoolap-desktop/releases/latest) and run it.

## Getting Started

1. **Launch** the app. The sidebar is empty on first run.
2. **Open or create a database.** Use the toolbar's **Connect** button or `File → Open Database` to point at an existing Stoolap folder, or `File → New In-Memory Database` to spin up a scratch DB.
3. **Try the example database.** `File → Load Example Database` seeds a memory DB with customers / products / orders, a vector `knowledge_base` table, and a tab of ready-to-run queries — including vector k-NN and hybrid search.
4. **Browse.** Expand tables in the sidebar to see columns, indexes, foreign keys, and DDL. Click a table to open a data view in a new tab.
5. **Query.** `Cmd/Ctrl+T` opens a new editor tab; `Cmd/Ctrl+Enter` runs.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Enter` | Execute query (current selection or whole buffer) |
| `Cmd/Ctrl + E` | Explain query plan |
| `Cmd/Ctrl + Shift + F` | Format SQL |
| `Cmd/Ctrl + T` | New editor tab |
| `Cmd/Ctrl + W` | Close tab |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | Next / previous tab |
| `Cmd/Ctrl + B` | Toggle sidebar |
| `Cmd/Ctrl + F` | Search in results grid |
| `Cmd/Ctrl + C` | Copy selected cells |
| `Cmd/Ctrl + O` | Open database |
| `Cmd/Ctrl + N` | New in-memory database |
| `Cmd/Ctrl + Shift + S` | Backup database |
| `Cmd/Ctrl + ?` | Show this help |

## Building from Source

### Prerequisites

- **Rust** stable (`rustup install stable`)
- **Node.js** 20+
- **Platform toolchains:**
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf`
  - Windows: [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **Stoolap engine** checked out next to this repo (the desktop app uses a path dependency):
  ```
  ~/src/
  ├── stoolap-desktop/
  └── stoolap/
  ```

  ```sh
  git clone https://github.com/stoolap/stoolap.git
  ```

### Run in Development

```sh
git clone https://github.com/stoolap/stoolap-desktop.git
cd stoolap-desktop
npm install
npm run dev
```

Tauri spawns the Vite dev server and opens a native window with hot-reload.

### Production Build

```sh
npm run build
```

Outputs:
- **macOS** — `src-tauri/target/release/bundle/macos/Stoolap Desktop.app` + `…/dmg/*.dmg`
- **Linux** — `…/appimage/*.AppImage` + `…/deb/*.deb`
- **Windows** — `…/msi/*.msi`

### Linting

```sh
# Frontend type check + production build
npx tsc --noEmit
npm run vite:build

# Rust strict clippy
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)
```

## Architecture

```
┌────────────────────────────────────────────┐
│  React + TypeScript UI (src/renderer)      │
│  CodeMirror · TanStack Query / Table /     │
│  Virtual · Zustand · shadcn/radix          │
└──────────────────┬─────────────────────────┘
                   │  Tauri invoke / event
┌──────────────────┴─────────────────────────┐
│  Rust Tauri backend (src-tauri/src)        │
│  ├── commands::connection                  │
│  ├── commands::query                       │
│  ├── commands::schema                      │
│  ├── commands::data                        │
│  └── commands::system                      │
└──────────────────┬─────────────────────────┘
                   │  direct Rust API
┌──────────────────┴─────────────────────────┐
│  stoolap engine (crate, embedded)          │
│  MVCC · columnar storage · HNSW · optimizer│
└────────────────────────────────────────────┘
```

- **`src/renderer/`** — React 19 + TypeScript UI. State is a mix of Zustand stores (connections, editor tabs) and TanStack Query (schema, row data). Styling is Tailwind 4 with shadcn/radix primitives.
- **`src-tauri/`** — Rust. `DbManager` holds one `Arc<Database>` per open connection so transactions persist across IPC calls while cross-connection queries run concurrently. All SQL paths parameterize user input via `?` placeholders.
- **`stoolap`** — the database engine itself; see its [repo](https://github.com/stoolap/stoolap) for engine docs.

### Plugin Inventory

| Plugin | Purpose |
|--------|---------|
| `tauri-plugin-dialog` | Native open / save / confirm dialogs |
| `tauri-plugin-fs` | Scoped filesystem access for export / import |
| `tauri-plugin-notification` | System notifications |
| `tauri-plugin-window-state` | Persist window size / position across launches |
| `tauri-plugin-updater` | Signed auto-update via GitHub Releases |
| `tauri-plugin-process` | Relaunch after applying an update |

## Releasing (maintainers)

Releases are driven by `.github/workflows/release.yml`, which triggers on any `v*` tag.

### One-time setup

1. Generate an updater signing keypair (already done for this repo):
   ```sh
   npx tauri signer generate -w ~/.tauri/stoolap-desktop.key
   ```
   Keep the private key safe — **lose it and no update can ever reach existing installs**.
2. Add repository secrets (`Settings → Secrets and variables → Actions`):

   **Required for auto-update:**
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/stoolap-desktop.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — empty if no password

   **Optional (macOS code signing + notarization):**
   - `APPLE_CERTIFICATE` (base64 of Developer ID `.p12`)
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Your Name (TEAMID)`)
   - `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`

### Cutting a release

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
2. Commit, tag, push:
   ```sh
   git commit -am "Release v0.4.1"
   git tag v0.4.1
   git push origin main v0.4.1
   ```
3. CI builds the matrix (macOS arm64 / Intel, Linux x64, Windows x64), signs updater artifacts, uploads a draft release with all DMGs / AppImages / MSIs, and generates `latest.json`.
4. The `publish-release` job flips the draft to published and pulls commit messages into the release notes.

Installed apps hit `https://github.com/stoolap/stoolap-desktop/releases/latest/download/latest.json` on **Check for Updates…** and prompt the user to install.

## Contributing

Issues and PRs welcome. Before opening a PR:

```sh
npx tsc --noEmit
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)
```

Both should pass cleanly.

## License

[Apache License 2.0](LICENSE) — same as the Stoolap engine.

## Related Projects

- **[stoolap](https://github.com/stoolap/stoolap)** — the embedded SQL engine
- **[stoolap-studio](https://github.com/stoolap/stoolap-studio)** — a browser-based sibling of this app (Next.js + WebAssembly / driver)
- Drivers: [stoolap-python](https://github.com/stoolap/stoolap-python) · [stoolap-node](https://github.com/stoolap/stoolap-node) · [stoolap-java](https://github.com/stoolap/stoolap-java) · [stoolap-swift](https://github.com/stoolap/stoolap-swift) · [stoolap-csharp](https://github.com/stoolap/stoolap-csharp) · [stoolap-ruby](https://github.com/stoolap/stoolap-ruby) · [stoolap-php](https://github.com/stoolap/stoolap-php)
