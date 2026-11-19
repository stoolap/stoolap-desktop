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

Stoolap Desktop is a lightweight native database client for the [Stoolap](https://github.com/stoolap/stoolap) embedded SQL engine. It embeds the Rust engine directly — no server, no bundled Chromium, no Node runtime — so the download stays under 10 MB and the app talks to your database at in-process speed.

Built with [Tauri 2](https://v2.tauri.app/) (Rust backend + WebKit/WebView2 frontend) and React. Stoolap Desktop 0.5.3 embeds Stoolap 0.5.0 from crates.io, with the engine's jemalloc allocator.

## Why Stoolap Desktop?

- **Small** — Tauri wraps the system WebView; the macOS DMG is about 8 MB (about 17 MB installed) instead of the 100+ MB a typical Electron database client ships.
- **In-process engine** — `stoolap` is linked as a Rust crate. There is no IPC to a driver, no "connector" to misconfigure, and transactions run at the same latency the underlying engine gives you.
- **Full Stoolap feature surface** — time-travel queries (`AS OF TIMESTAMP`), HNSW vector search, multi-column indexes, MVCC transactions, and rich DDL are first-class in the UI, not bolted on.
- **SQL agent that knows Stoolap** — Claude or ChatGPT writes and runs SQL in your query tab, with a Stoolap dialect guide tested against the engine; changes to data only run when you allow them.
- **16 languages** — the interface and menus follow your system language, or the one you pick in Settings.
- **Native feel on macOS** — overlay title bar, system accent color, system appearance follows light/dark, native context menus and file dialogs.
- **Auto-update built in** — code-signed updater ships new versions over a GitHub Releases feed.

## Screenshots

<img src="docs/assets/img/desktop-light.png#gh-light-mode-only" alt="Stoolap Desktop" width="100%">
<img src="docs/assets/img/desktop-dark.png#gh-dark-mode-only" alt="Stoolap Desktop" width="100%">

## Features

### SQL Editor
- Multi-tab CodeMirror editor with a Stoolap SQL dialect (keywords, types, built-in functions)
- Schema-aware autocomplete (table and column names)
- Execute with `Cmd/Ctrl+Enter`; run `EXPLAIN` with `Cmd/Ctrl+E`
- Multi-statement execution with automatic `BEGIN`/`COMMIT` wrapping for DML, run in its own session so other work on the connection does not join it
- A transaction you open with `BEGIN` stays open across runs until you `COMMIT` or `ROLLBACK`
- A script of several statements shows every statement's result in its own tab over the grid; an error names the statement that failed
- Query history per session
- The time shown for a run is what you waited, from the request to the rows on screen, not only the engine's share
- Query timeout in the status bar (30 s to 1 hour, or off; 5 min by default): the engine cancels statements that run longer. **Stop** only stops waiting, because the engine cannot interrupt a statement from outside; the timeout is what ends it

### SQL Agent
- Right-hand panel (`Cmd/Ctrl+L`, or the sparkle button next to the tabs) that writes, fixes, explains and speeds up the SQL in the current tab
- Runs through your local Claude Code (your own Claude sign-in and plan) when it is installed. Otherwise it calls the Claude API with your Anthropic account, signed in with the browser (billed to your Console organization; nothing to install or copy), or with an API key. It can also use ChatGPT, through your local Codex signed in with your ChatGPT account, or the OpenAI API with a key
- Pick the model in the panel: Claude Opus 5.5 (default), Sonnet 5.5, Haiku 5.5 or Fable 5.2; with ChatGPT, the models your account or key offers
- Knows Stoolap: every request carries a guide to Stoolap's SQL dialect (every type and function that exists, statement syntax, what fails and what to write instead, how the planner uses indexes), checked against the engine: `cargo test` runs each of its examples. For details it searches and reads the bundled Stoolap 0.5 documentation (55 pages)
- Works in a query tab, in front of you: a new tab of its own by default, or the tab you are on ("New tab" / "This tab"). The SQL appears in the editor as it is written, runs there and fills the result grid, and the agent reads the outcome (up to 50 rows and how long each statement took, sent to the provider you chose) and continues, pausing briefly between runs so you can follow along. Each edit can be undone from the panel
- Reads always run. SQL that changes data (INSERT, UPDATE, DELETE, DDL) or a script of several statements runs only when you allow writes for that database ("Run writes", off by default); otherwise it is written into the tab and waits for your **Run**
- **Fix with agent** on a query error
- Earlier conversations for each database (the history button); a conversation picked up after a restart sends its earlier messages along
- `↑`/`↓` recall earlier requests, `Tab` takes a completion drawn from them and the schema, `@` inserts table and column names, and suggested requests follow the open tab (its error, selection, SQL) and the tables
- Replies can be selected and copied; code blocks have a Copy button
- With Claude Code, its built-in tools (shell, files, web) are turned off; it only gets this app's database tools, through an MCP server on 127.0.0.1. With the API, requests go from the Rust backend straight to Anthropic: a browser sign-in goes through Anthropic's `ant` CLI, which the app downloads on first use (a pinned release, checked against its SHA-256) and runs with a config directory of its own, so it never touches your own `ant` or Claude Code sign-in; the app asks it for a short-lived token per request and never reads its credentials file, and an API key is kept in the system credential store (Keychain, Windows Credential Manager, Secret Service)
- Codex runs with a Codex home of the app's own, so your Codex plugins, MCP servers, memories and instructions never load, and you sign in to ChatGPT once from the app. Its shell, browser, computer-use, web-search and plugin tools are turned off, the database tools are passed to it directly, and any command or file change it asks to make is declined. The OpenAI API is called from the Rust backend with `store: false`, so OpenAI keeps no copy of the conversation

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
- Create standard or HNSW indexes via dialog; the engine picks the standard index type (B-tree for TEXT columns since Stoolap 0.5.0), and `CREATE INDEX ... USING HASH | BITMAP` in the editor sets it explicitly
- Multi-column indexes, `UNIQUE` option, named constraints
- k-NN search template generation from any HNSW index

### Table & View Management
- Create tables with a visual dialog: column types, constraints (`PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `AUTO_INCREMENT`, `CHECK`), foreign keys with `ON DELETE` / `ON UPDATE` actions, and defaults
- Alter tables (add / modify / drop columns)
- Create and drop views
- DDL preview before any destructive action

### Backup & Restore
- One-shot SQL dump export — tables, data, views, indexes, `DROP IF EXISTS` guards, FK-dependency-ordered (tables created parents first, dropped children first)
- Index types (B-tree, Hash, Bitmap, HNSW) are written explicitly, so a restore recreates the same index
- Streams chunks directly to disk; safe for databases larger than RAM
- Restore from any SQL dump with per-statement progress and optional transaction wrapping
- HNSW index parameters (`metric`, `m`, `ef_construction`) are preserved in the backup and re-applied on restore

### Native Integration
- macOS: overlay title bar with hidden title, system accent color live-tracked, native context menus, proper app menu with `About`, `Check for Updates…`, `Settings…`, services submenu, quit
- System notifications on long-running operations (backup complete, export finished, import complete), and for a query that ran 10 s or more while the window was in the background
- Native file / folder dialogs via the OS picker
- Drop a database folder onto the window to open it, or a `.sql` file to open it in a new tab
- `File → Open Recent` lists recently opened databases
- Single instance: launching the app again focuses the open window; a database folder passed on the command line opens there
- Windows and Linux: `File → Settings…`, and a `Help` menu with `Check for Updates…` and `About`
- Window state persistence — size, position, and maximized state restore on next launch
- Single-process: the engine is linked in, not spawned

### Theming & Accessibility
- Follows system light / dark appearance
- Accent color pulled from the OS (macOS `NSColor.controlAccentColor`)
- Keyboard navigation throughout; full shortcut sheet via `Cmd/Ctrl + ?`

### Languages
- English, Türkçe, Deutsch, Français, Español, Português (Brasil), Italiano, Nederlands, Polski, Русский, Українська, 日本語, 한국어, 简体中文, 繁體中文 and Bahasa Indonesia, menus included
- Follows the system language; **Settings… (`Cmd/Ctrl + ,`)** picks another one, which then stays

### Auto-Update
- Bundled `tauri-plugin-updater` checks a signed `latest.json` feed on GitHub Releases
- User sees a dialog with the version, release notes, progress bar, and "Install & Restart"
- The release notes are the version's section of [CHANGELOG.md](CHANGELOG.md); the release workflow publishes them on the GitHub release and in `latest.json`, and refuses to release a tag without one
- Every update bundle is ed25519-signed with the maintainer's private key; the app refuses to install anything that doesn't verify against the public key baked into the binary

## Installation

### macOS

Download `Stoolap.Desktop_<version>_aarch64.dmg` (Apple Silicon) or `Stoolap.Desktop_<version>_x64.dmg` (Intel) from the [latest release](https://github.com/stoolap/stoolap-desktop/releases/latest), open the DMG, and drag Stoolap Desktop to `/Applications`.

If the app isn't notarized yet, right-click → **Open** the first time to bypass Gatekeeper.

### Linux

Download the `.AppImage` (portable), `.deb` (Debian / Ubuntu) or `.rpm` (Fedora / RHEL / openSUSE) from the [latest release](https://github.com/stoolap/stoolap-desktop/releases/latest).

```sh
# AppImage
chmod +x Stoolap.Desktop_*_amd64.AppImage
./Stoolap.Desktop_*_amd64.AppImage

# .deb
sudo apt install ./Stoolap.Desktop_*_amd64.deb

# .rpm
sudo dnf install ./Stoolap.Desktop-*.x86_64.rpm
```

### Windows

Download the `_x64-setup.exe` or `_x64_en-US.msi` installer from the [latest release](https://github.com/stoolap/stoolap-desktop/releases/latest) and run it.

## Getting Started

1. **Launch** the app. With no database open, the start screen offers to open one, create an in-memory one, or load the example, and lists recent databases.
2. **Open or create a database.** Use `File → Open Database` (or drop the folder onto the window) to point at an existing Stoolap folder, or `File → New In-Memory Database` to spin up a scratch DB.
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
| `Cmd/Ctrl + L` | Toggle the agent panel |
| `Cmd/Ctrl + F` | Search in results grid |
| `Cmd/Ctrl + C` | Copy selected cells |
| `Cmd/Ctrl + O` | Open database |
| `Cmd/Ctrl + N` | New in-memory database |
| `Cmd/Ctrl + Shift + S` | Backup database |
| `Cmd/Ctrl + ,` | Settings (language) |
| `Cmd/Ctrl + ?` | Show this help |

## Building from Source

### Prerequisites

- **Rust** stable (`rustup install stable`)
- **Node.js** 20+
- **Platform toolchains:**
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf`
  - Windows: [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

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
- **Linux** — `…/appimage/*.AppImage` + `…/deb/*.deb` + `…/rpm/*.rpm`
- **Windows** — `…/msi/*.msi` + `…/nsis/*-setup.exe`

### Linting

```sh
# Frontend type check, production build and unit tests
npx tsc --noEmit
npm run vite:build
npm test

# Rust strict clippy and tests
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)
(cd src-tauri && cargo test)
```

## Architecture

```
┌────────────────────────────────────────────┐
│  React + TypeScript UI (src/renderer)      │
│  CodeMirror · TanStack Query / Table /     │
│  Virtual · Zustand · shadcn/radix · i18next│
└──────────────────┬─────────────────────────┘
                   │  Tauri invoke / event
┌──────────────────┴─────────────────────────┐
│  Rust Tauri backend (src-tauri/src)        │
│  ├── commands::connection                  │
│  ├── commands::query                       │
│  ├── commands::schema                      │
│  ├── commands::data                        │
│  ├── commands::system                      │
│  ├── agent (Claude / OpenAI, MCP tools)    │
│  └── i18n (language, menu, messages)       │
└──────────────────┬─────────────────────────┘
                   │  direct Rust API
┌──────────────────┴─────────────────────────┐
│  stoolap engine (crate, embedded)          │
│  MVCC · columnar storage · HNSW · optimizer│
└────────────────────────────────────────────┘
```

- **`src/renderer/`** — React 19 + TypeScript UI. State is a mix of Zustand stores (connections, editor tabs, the agent) and TanStack Query (schema, row data). Styling is Tailwind 4 with shadcn/radix primitives; text comes from `src/renderer/src/locales` through react-i18next.
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
| `tauri-plugin-single-instance` | Focus the running app instead of starting a second one |

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

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (and the lockfiles: `npm install --package-lock-only`, `cargo check`).
2. Add a `## vX.Y.Z` section to [CHANGELOG.md](CHANGELOG.md): it becomes the release note on GitHub and in the in-app update dialog, and the release fails without it.
3. Merge that to `main`, then tag and push:
   ```sh
   git tag v0.5.3
   git push origin v0.5.3
   ```
4. CI builds the matrix (macOS arm64 / Intel, Linux x64, Windows x64), signs the updater artifacts, uploads them to a draft release with `latest.json`, and the `publish-release` job publishes it with the CHANGELOG section as its notes.

Installed apps hit `https://github.com/stoolap/stoolap-desktop/releases/latest/download/latest.json` on **Check for Updates…** and prompt the user to install.

## Contributing

Issues and PRs welcome. Before opening a PR:

```sh
npx tsc --noEmit && npm test
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings && cargo test)
```

All should pass cleanly.

### Translations

The app's text lives in [`src/renderer/src/locales`](src/renderer/src/locales): one folder per language, with the same JSON files as `en/`. `native.json` holds the menu labels, which the Rust side reads too. To fix a translation, edit the value in that language's file; to add a language, copy `en/`, translate it, and add the language to `LANGUAGES` in `src/renderer/src/lib/i18n.ts` and `NATIVE` in `src-tauri/src/i18n.rs`. `npm test` checks that every language has every key and keeps each `{{variable}}`. Corrections from native speakers are very welcome.

## License

[Apache License 2.0](LICENSE) — same as the Stoolap engine.

## Related Projects

- **[stoolap](https://github.com/stoolap/stoolap)** — the embedded SQL engine
- **[stoolap-studio](https://github.com/stoolap/stoolap-studio)** — a browser-based sibling of this app (Next.js, with the engine in-process through `@stoolap/node`)
- Drivers: [stoolap-python](https://github.com/stoolap/stoolap-python) · [stoolap-node](https://github.com/stoolap/stoolap-node) · [stoolap-java](https://github.com/stoolap/stoolap-java) · [stoolap-swift](https://github.com/stoolap/stoolap-swift) · [stoolap-csharp](https://github.com/stoolap/stoolap-csharp) · [stoolap-ruby](https://github.com/stoolap/stoolap-ruby) · [stoolap-php](https://github.com/stoolap/stoolap-php)
