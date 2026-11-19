# Changelog

Each release's section is its release note: the release workflow publishes it
on the GitHub release and in the update notice the app shows. Add the section
before tagging; the release fails without one.

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
