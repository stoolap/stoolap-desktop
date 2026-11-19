# Changelog

Each release's section is its release note: the release workflow publishes it
on the GitHub release and in the update notice the app shows. Add the section
before tagging; the release fails without one.

## v0.5.8

### Look and feel
- A thin line now separates the title bar from the content, and the status bar's line matches the side panels'.

### Under the hood
- Updated to Tauri 2.12 and its plugins (the updater, notifications, dialogs, files and windows among them), and every library the app is built on to its latest stable version: React 19.3, TypeScript 7, Vite 8, the table behind the result grid, the translations and the icons among them.

## v0.5.7

### Fixes
- On macOS the window can be moved again by dragging its title bar, and double-clicking the title bar zooms it.
- The agent no longer starts Claude Code on its own the first time you use it. You choose how it runs (Claude Code is recommended when it is installed), once; a request made before that, such as **Fix with agent**, waits for your choice.

## v0.5.6

### Scripts and transactions
- A script that starts its own transaction with BEGIN and then fails no longer leaves that transaction open. It is rolled back, and the error says so; before, every later run joined the half-finished transaction without warning. A transaction you opened yourself in an earlier run stays open, and the error reminds you to COMMIT or ROLLBACK.
- When a script fails, the results of the statements that ran before it still show, under the error, and the error says which statements didn't run.
- The status bar shows **Transaction open** while your session is inside a transaction.

### Agent
- The agent knows when your session is inside a transaction, and that its own checks don't see uncommitted changes.
- Its history of your runs says what became of each transaction (committed, rolled back, still open), tells a query plan from data rows, and marks an EXPLAIN ANALYZE that ran a write.

### Look and feel
- A darker, higher-contrast dark mode with neutral greys, and crisper text in light mode.
- Your messages in the agent panel stand apart from the agent's replies.

## v0.5.5

### Agent
- The agent can now check things for itself without touching your tab: a count, the values in a column, whether a row exists, a query plan with real timings. Each check runs in a transaction that is rolled back, so nothing it does stays, and it shows in the panel as a step you can open to see the SQL and the rows it got back.
- For timing questions it can run a query several times and compare the slowest, the fastest and the typical run, instead of trusting a single measurement.
- It can read your other query tabs (with the last error each one showed) and your recent runs on the database, with when they ran and how long they took, so it can answer questions like "why is this slower than yesterday?".
- It knows whether the database is in memory or a folder on disk, which matters for COPY file paths and time-travel queries.
- The agent names the tab it works in after what the query does, and reuses an empty agent tab instead of opening another.
- Each reply has a Copy button.

### Queries and results
- Every run is now kept, with how long it took and what it returned, for the agent's history.
- Hovering **In-Memory** in the status bar explains that its changes are lost when the database or the app closes.

## v0.5.4

### Look and feel
- Tooltips across the app now match its look and show quickly, like the engine version in About, instead of the system's slow plain tooltips. Over grid cells and table names they wait a little longer, so moving the mouse across a table doesn't flash a tooltip on every cell.
- The About window no longer spills past its edge when the link labels are long, as in Turkish.
- In a narrow Agent panel, the **Run writes** label now shortens instead of pushing the Send button out of sight.
- Turkish: **Run writes** is now "Yazmaya izin ver".

## v0.5.3

### Languages
- Stoolap Desktop speaks 16 languages: English, Türkçe, Deutsch, Français, Español, Português (Brasil), Italiano, Nederlands, Polski, Русский, Українська, 日本語, 한국어, 简体中文, 繁體中文 and Bahasa Indonesia. Menus, dialogs, error messages and the agent's step labels are translated, and numbers and dates follow the language.
- The app follows your system language. **Settings…** (⌘, / Ctrl+,) picks another one, which then stays, and the menus switch at once.
- The translations have not all been reviewed by native speakers yet; corrections are welcome on GitHub.

### Agent
- The SQL assistant is now called **Agent**. Your conversations and settings carry over.
- The agent now sees how long each query it ran took, so it can tell when a query is slow.

### Queries and results
- Large results arrive faster: on an Apple Silicon Mac, a 100,000-row SELECT shows in about 32 ms instead of 44 ms, a million rows in about 350 ms instead of 455 ms.
- The time shown for a run is what you waited, from running it to the rows on screen; before, it left out sending the rows to the window.
- The sidebar refreshes after INSERT, UPDATE and DELETE (row counts), and after a CREATE or DROP that comes after a comment, as the agent's SQL usually does.

### Look and feel
- A new About window, with a **Copy versions** button for bug reports and links to the website, GitHub and the changelog.
- Release notes in the update window show formatted, from the next update on.
- Dialogs no longer open with the close button looking selected.

## v0.5.2

### SQL assistant
- Replies render as Markdown: bold text, lists, tables and links (they open in your browser), with highlighted SQL blocks and a Copy button.
- **Run again** on an earlier suggestion runs that suggestion's SQL, not whatever the open tab holds.
- A change the assistant was about to run no longer runs once you press Stop, delete the chat, switch to another database or turn off **Run writes**.
- Switching to another provider in the middle of a conversation keeps what was said, even when the first request on the new provider fails.
- Stop ends the wait right away, also when the provider stops answering.
- A change hidden behind quotes or comments is no longer taken for a query that only reads.

### Queries
- **Explain** on several statements explains each one instead of running them.
- A script joins the transaction you began with BEGIN, and a failed COMMIT or a ROLLBACK TO SAVEPOINT no longer confuses the app about whether one is open.
- INSERT, UPDATE and DELETE with RETURNING (also inside WITH) show the rows they return.
- Statements are split the way Stoolap reads them: backslash escapes in strings, `#` comments and backtick names.
- The formatter keeps operators such as `>=`, `<>` and `->>` whole, and a `--` comment no longer swallows the next line.
- Stop works for queries started from the keyboard, and starting another query in the tab keeps its Stop button.

### Tables and data
- Integers beyond JavaScript's safe range (2^53) show, edit and delete the right row.
- Two data tabs of the same table each keep their own filter.
- Vector filters work again.
- CSV and JSON import works with file paths that contain quotes or backslashes.

### Backup and restore
- Backups keep backslashes, large integers and the difference between JSON `null` and SQL `NULL`.
- Restore stops at the first error and reports it, and keeps the file's order. The transaction option now says what an error rolls back: the rows since the last CREATE (or other statement that isn't a row change).

## v0.5.1

### SQL assistant
- A new assistant panel on the right (⌘L / Ctrl+L) writes, fixes, explains and speeds up SQL for the open database. It works in a query tab in front of you: it writes the SQL into the tab and runs it there, so results show in the grid.
- Queries that only read run on their own. Changes to data run only after you turn on **Run writes** for that database; otherwise the SQL waits in the tab for you to press Run.
- Use your local Claude Code, your Anthropic account (sign in with the browser) or an Anthropic API key, or ChatGPT through your local Codex or an OpenAI API key. You pick the model. Keys stay in the system credential store, and the assistant only gets this app's database tools: no shell, files or web.
- The assistant knows Stoolap's SQL dialect and searches the Stoolap documentation built into the app.
- Earlier conversations for each database, ↑/↓ to recall earlier requests, completions as you type (Tab), `@` to insert table and column names, and suggestions that fit the open tab.
- Code in replies has a Copy button, and replies can be selected and copied.

### Queries and results
- Running several statements shows each one's result as a tab ("Result #1: 10 rows").
- A query timeout in the status bar stops queries that run too long (5 minutes by default).
- EXPLAIN results show as a plan even when comments come before the EXPLAIN.
- Numeric column headers line up with their values, and a newly opened tab scrolls into view.

### Desktop
- Stoolap Desktop runs as one instance: starting it again brings the open window to the front.
- Drop a database file on the window to open it, and use **File → Open Recent**.
- A new welcome screen, and quieter notifications that only appear when something needs your attention.
- The Examples tabs no longer reopen at every launch.

### Fixes
- ⌘Enter in the editor runs the query instead of adding a new line.
- Loading the examples no longer opens two Examples tabs.
- Actions that fail (dropping a table, creating an index, …) no longer report success.
