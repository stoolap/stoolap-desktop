# Changelog

Each release's section is its release note: the release workflow publishes it
on the GitHub release and in the update notice the app shows. Add the section
before tagging; the release fails without one.

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
