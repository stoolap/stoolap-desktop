//! The agent's tools. The reading ones run here; `write_query` is
//! carried out by the renderer in the user's editor tab (see mod.rs), and
//! [format_run] turns what that run returned into the model's tool result.

use super::docs_index::PAGES;
use super::mcp::McpSession;
use crate::db::DbManager;
use crate::i18n::{t, t_count};
use serde::Deserialize;
use serde_json::{json, Value};
use stoolap::parser::ast::Statement;

/// A query tab as the renderer last reported it
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub id: String,
    pub title: String,
    pub sql: String,
    /// The tab the user is looking at
    #[serde(default)]
    pub active: bool,
    /// "this" or "other" database it last ran on (named), and when; none if it never ran
    #[serde(default)]
    pub ran_on: Option<String>,
    #[serde(default)]
    pub ran_on_name: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<String>,
    /// The error its last run showed, if it failed
    #[serde(default)]
    pub last_error: Option<String>,
}

/// The user's tabs and this database's recent runs (newest first)
#[derive(Deserialize, Default)]
pub struct Live {
    #[serde(default)]
    pub tabs: Vec<TabSnapshot>,
    #[serde(default)]
    pub runs: Vec<Value>,
}

/// Rows of a check the panel shows when the step is opened
const DETAIL_ROWS: usize = 20;
/// Most times one check_query may run its statement
const MAX_REPEAT: usize = 10;
/// Runs query_history returns by default and at most, and the SQL it shows of each
const HISTORY_RUNS: usize = 30;
const MAX_HISTORY_RUNS: usize = 50;
const SQL_CHARS: usize = 400;

/// Rows of a run the model sees, and the longest cell it sees.
const MAX_ROWS: usize = 50;
const MAX_CELL_CHARS: usize = 200;

pub fn definitions() -> Value {
    let strict_object = |properties: Value, required: Value| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        })
    };
    json!([
        {
            "name": "list_tables",
            "description": "List the tables (with their row counts) and views in the open database.",
            "strict": true,
            "input_schema": strict_object(json!({}), json!([])),
        },
        {
            "name": "describe_table",
            "description": "The CREATE statement of a table or view (columns, types, constraints, foreign keys) and the table's indexes.",
            "strict": true,
            "input_schema": strict_object(
                json!({"name": {"type": "string", "description": "Table or view name"}}),
                json!(["name"]),
            ),
        },
        {
            "name": "search_stoolap_docs",
            "description": "Full-text search over the Stoolap 0.5 documentation. Returns the best-matching sections with their page ids. Use it whenever you are unsure whether Stoolap supports a function, syntax or behaviour, before writing SQL that relies on it.",
            "strict": true,
            "input_schema": strict_object(
                json!({"query": {"type": "string", "description": "Words to look for, e.g. \"window frame ROWS BETWEEN\" or \"upsert duplicate key\""}}),
                json!(["query"]),
            ),
        },
        {
            "name": "read_stoolap_docs",
            "description": "Read a page of the Stoolap 0.5 documentation. The pages are listed in the system prompt. Read the relevant page before using syntax or functions you are not sure Stoolap supports.",
            "strict": true,
            "input_schema": strict_object(
                json!({"page": {"type": "string", "description": "Page id, e.g. sql-features/returning"}}),
                json!(["page"]),
            ),
        },
        {
            "name": "check_query",
            "description": "Run one read-only statement (SELECT, WITH ... SELECT, SHOW, DESCRIBE, PRAGMA without a value, or EXPLAIN / EXPLAIN ANALYZE of a read) to check something for yourself, without touching the user's tab: a count, a distinct list, whether a value exists, a plan with real timings. It runs in its own transaction that is rolled back, under the query timeout. You get the columns, up to 50 rows, the total row count and how long it took; the user sees each check, its SQL and its first 20 rows as a step in the agent panel, a refused or failed check as an error step. Its time is the engine's, inside a rolled-back transaction, so it is lower than the user's wait in query_history. Prefer small results (aggregates, LIMIT). To show the user something, or to change data, use write_query.",
            "strict": true,
            "input_schema": strict_object(
                json!({
                    "sql": {"type": "string", "description": "One read-only statement"},
                    "repeat": {"type": ["integer", "null"], "description": "Run it this many times (at most 10) and get the min, median and max time: for timing questions, where one run is noise. Default 1."}
                }),
                json!(["sql", "repeat"]),
            ),
        },
        {
            "name": "list_tabs",
            "description": "List the user's query tabs: id, title, size, a preview of the first lines, where it last ran (this database, another named one, or never; tabs are not tied to a database) and when, which one is in front (active: the one the user is looking at; your writes bring your tab to the front) and which is yours. Current: it reflects your writes during this request. The <editor> block only holds the tab the user is looking at.",
            "strict": true,
            "input_schema": strict_object(json!({}), json!([])),
        },
        {
            "name": "read_tab",
            "description": "Read the SQL in one of the user's query tabs, by the id list_tabs gave.",
            "strict": true,
            "input_schema": strict_object(
                json!({"tab_id": {"type": "string", "description": "A tab id from list_tabs"}}),
                json!(["tab_id"]),
            ),
        },
        {
            "name": "query_history",
            "description": "Recent runs on this database, newest first, yours and the user's: local time with its UTC offset (usable in AS OF TIMESTAMP) and how long ago, how long it took, the outcome (rows, changed rows, error; for a script, each statement's), the tab it ran in and who ran it, with the SQL (long SQL shortened; read_tab has a tab's full SQL). A run's time is what the user waited, sending the result to the window included; a script statement's time is the engine's alone, so they don't add up. Use it to compare a query's speed over time or to see what the user tried.",
            "strict": true,
            "input_schema": strict_object(
                json!({
                    "limit": {"type": ["integer", "null"], "description": "How many runs, newest first (default 30, at most 50)"},
                    "tab": {"type": ["string", "null"], "description": "Only runs in the tab with this title"}
                }),
                json!(["limit", "tab"]),
            ),
        },
        {
            "name": "write_query",
            "description": "Write SQL into the editor tab you work in (write_into), replacing what is there: pass the complete new content. The user watches it appear and can undo it. Reads (SELECT, WITH ... SELECT, SHOW, DESCRIBE, EXPLAIN) then run in the tab, the user sees the result grid, and you get the outcome: the error, or the columns and up to 50 rows. SQL that can change data, or several statements, runs only when the user allows writes (run_writes=\"allowed\"); otherwise it is only written and the user decides whether to run it.",
            "strict": true,
            "eager_input_streaming": true,
            "input_schema": strict_object(
                json!({
                    "sql": {"type": "string", "description": "The complete new editor content"},
                    "explanation": {"type": "string", "description": "One or two sentences on what changed and why"},
                    "title": {"type": ["string", "null"], "description": "A short name for your tab, 2 to 5 words (e.g. \"Top customers by revenue\"): give one on your first write, then only when the query's purpose changes; null keeps the name. Only your own tab is renamed; the user's tabs keep their names."}
                }),
                json!(["sql", "explanation", "title"]),
            ),
        }
    ])
}

/// What a tool produced: the text the model sees, a short line for the UI,
/// and what that line shows when opened.
pub struct Output {
    pub content: String,
    pub is_error: bool,
    pub summary: String,
    pub detail: Option<Value>,
}

fn ok(content: String, summary: String) -> Output {
    Output { content, is_error: false, summary, detail: None }
}

fn err(message: impl Into<String>) -> Output {
    let message = message.into();
    Output { content: message.clone(), is_error: true, summary: message, detail: None }
}

fn str_arg<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn quote_id(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

/// Run a tool that reads the database, the user's tabs and runs, or the
/// docs. `write_query` is handled by the caller, which owns the UI.
pub fn run(db: &DbManager, target: &McpSession, name: &str, input: &Value) -> Output {
    let conn_id = target.conn_id.as_str();
    match name {
        "check_query" => match str_arg(input, "sql") {
            Some(sql) => check_query(db, conn_id, sql, input.get("repeat").and_then(Value::as_u64).unwrap_or(1) as usize),
            None => err("check_query needs a statement"),
        },
        "list_tabs" => list_tabs(target),
        "read_tab" => match str_arg(input, "tab_id") {
            Some(id) => read_tab(target, id),
            None => err("read_tab needs a tab id from list_tabs"),
        },
        "query_history" => query_history(
            target,
            input.get("limit").and_then(Value::as_u64).map(|n| n as usize),
            str_arg(input, "tab"),
        ),
        "list_tables" => list_tables(db, conn_id),
        "describe_table" => match str_arg(input, "name") {
            Some(t) => describe_table(db, conn_id, t),
            None => err("describe_table needs a table name"),
        },
        "search_stoolap_docs" => match str_arg(input, "query") {
            Some(q) => search_docs(q),
            None => err("search_stoolap_docs needs a query"),
        },
        "read_stoolap_docs" => match str_arg(input, "page") {
            Some(p) => read_docs(p),
            None => err("read_stoolap_docs needs a page id"),
        },
        other => err(format!("Unknown tool: {other}")),
    }
}

/// Whether `sql` is one read-only statement, and if so whether it is an
/// EXPLAIN (its rows are a plan). Read with the engine's own parser. EXPLAIN
/// ANALYZE runs its statement, so it is in only when that statement reads
/// (and the check's rollback holds anyway).
fn read_only(sql: &str) -> Result<bool, String> {
    fn reads(s: &Statement) -> bool {
        match s {
            Statement::Select(_)
            | Statement::ShowTables(_)
            | Statement::ShowViews(_)
            | Statement::ShowCreateTable(_)
            | Statement::ShowCreateView(_)
            | Statement::ShowIndexes(_)
            | Statement::Describe(_) => true,
            // PRAGMA x reads a setting; PRAGMA x = v changes it
            Statement::Pragma(p) => p.value.is_none(),
            Statement::Explain(e) => reads(&e.statement),
            _ => false,
        }
    }
    let statements = stoolap::parser::parse_sql(sql).map_err(|e| format!("It does not parse: {e}"))?;
    match statements.as_slice() {
        [one] if reads(one) => Ok(matches!(one, Statement::Explain(_))),
        [_] => Err("check_query only reads: SELECT, WITH ... SELECT, SHOW, DESCRIBE, PRAGMA without a value, or EXPLAIN (ANALYZE) of one of those. Use write_query for anything else.".into()),
        _ => Err("check_query runs exactly one statement.".into()),
    }
}

/// Run a read-only statement in a session of its own, inside a transaction
/// that is rolled back, so nothing it does can stay.
fn check_query(db: &DbManager, conn_id: &str, sql: &str, repeat: usize) -> Output {
    let is_plan = match read_only(sql) {
        Ok(is_plan) => is_plan,
        Err(why) => return Output { detail: Some(json!({"sql": sql, "error": why})), ..err(why) },
    };
    let repeat = repeat.clamp(1, MAX_REPEAT);
    let ms = |start: std::time::Instant| (start.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
    // Each run in its own transaction, rolled back: nothing it does can stay
    let mut times = Vec::with_capacity(repeat);
    let mut first = 0.0;
    let result = (|| {
        let handle = db.get_db(conn_id)?;
        let session = db.session(&handle)?;
        let mut last = None;
        for _ in 0..repeat {
            let start = std::time::Instant::now();
            DbManager::execute_on(&session, "BEGIN", None)?;
            let result = DbManager::query_on(&session, sql, None);
            let _ = DbManager::execute_on(&session, "ROLLBACK", None);
            let took = ms(start);
            if times.is_empty() {
                first = took;
            }
            times.push(took);
            last = Some(result?);
        }
        last.ok_or_else(|| "nothing ran".to_string())
    })();
    times.sort_by(f64::total_cmp);
    let median = times.get(times.len() / 2).copied().unwrap_or(0.0);
    match result {
        Ok(r) => {
            let count = r.rows.len();
            let detail = json!({
                "sql": sql,
                "columns": r.columns,
                "rows": r.rows.iter().take(DETAIL_ROWS).collect::<Vec<_>>(),
                "rowCount": count,
                "time": median,
                "runs": repeat,
            });
            let timeout = match db.query_timeout_ms() {
                0 => "no query timeout".to_string(),
                ms => format!("query timeout {ms} ms"),
            };
            let timing = match times.as_slice() {
                [_] => String::new(),
                all => format!(
                    " Ran {repeat} times: the first (cold) run {first} ms; over all runs min {} ms, median {median} ms, max {} ms.",
                    all[0],
                    all[all.len() - 1]
                ),
            };
            let shown = &r.rows[..count.min(MAX_ROWS)];
            let result = if is_plan {
                // Not "N rows in X ms": the rows are plan lines, and the
                // plan's own times are inside them
                format!(
                    "A plan of {count} lines; the check took {median} ms in all, and the plan's own times are in it.\n{}",
                    table_text(&r.columns, shown)
                )
            } else {
                statement_text(&json!({"columns": r.columns, "rows": r.rows, "rowCount": count, "time": median}))
            };
            Output {
                content: format!(
                    "Checked ({timeout}); the user's tab is unchanged. You get up to {MAX_ROWS} rows below; the user sees this check in the panel with its first {DETAIL_ROWS} rows.{timing} {result}"
                ),
                is_error: false,
                summary: t_count("steps.checked", count as i64, &[]),
                detail: Some(detail),
            }
        }
        Err(e) => Output {
            content: format!("The check failed: {e}"),
            is_error: true,
            summary: t("steps.checkFailed", &[("error", &e)]),
            detail: Some(json!({"sql": sql, "error": e, "time": median})),
        },
    }
}

fn list_tabs(target: &McpSession) -> Output {
    let live = target.live.lock().map(|l| l.tabs.clone()).unwrap_or_default();
    let tabs: Vec<Value> = live
        .iter()
        .map(|tab| {
            let last_ran_on = match (tab.ran_on.as_deref(), tab.ran_on_name.as_deref()) {
                (Some("this"), _) => "this database".to_string(),
                (Some(_), Some(name)) => format!("another database ({name})"),
                (Some(_), None) => "another database".to_string(),
                (None, _) => "never run".to_string(),
            };
            let mut entry = json!({
                "id": tab.id,
                "title": tab.title,
                "lines": tab.sql.lines().count(),
                "preview": preview(&tab.sql),
                "last_ran_on": last_ran_on,
                // Tabs that ran before run times were kept have none
                "last_run_at": match (&tab.last_run_at, &tab.ran_on) {
                    (Some(at), _) => Some(at.as_str()),
                    (None, Some(_)) => Some("not recorded (it ran before run times were kept)"),
                    // never run: last_ran_on says so
                    (None, None) => None,
                },
                "last_error": tab.last_error.as_deref().map(truncate),
                "active": tab.active,
                "yours": tab.id == target.tab_id,
            });
            // Fields a tab doesn't have are left out rather than null
            if let Some(fields) = entry.as_object_mut() {
                fields.retain(|_, v| !v.is_null());
            }
            entry
        })
        .collect();
    ok(json!(tabs).to_string(), t_count("steps.listedTabs", tabs.len() as i64, &[]))
}

/// A tab's first two non-empty lines, up to 120 characters
fn preview(sql: &str) -> Option<String> {
    let text = sql.lines().map(str::trim).filter(|l| !l.is_empty()).take(2).collect::<Vec<_>>().join(" ⏎ ");
    if text.is_empty() {
        return None;
    }
    Some(match text.char_indices().nth(120) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    })
}

fn read_tab(target: &McpSession, id: &str) -> Output {
    let tabs = target.live.lock().map(|l| l.tabs.clone()).unwrap_or_default();
    match tabs.iter().find(|tab| tab.id == id) {
        Some(tab) if tab.sql.trim().is_empty() => ok(format!("The tab \"{}\" is empty.", tab.title), t("steps.readTab", &[("tab", &tab.title)])),
        Some(tab) => {
            let mut text = tab.sql.clone();
            if let Some(e) = &tab.last_error {
                text.push_str(&format!("\n\n(The last run in this tab failed: {e})"));
            }
            ok(text, t("steps.readTab", &[("tab", &tab.title)]))
        }
        None => err(format!("No tab with id {id}; list_tabs gives the ids.")),
    }
}

/// How long ago `at` (epoch ms) was, for the model
fn ago(at: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(at);
    let mins = now.saturating_sub(at) / 60_000;
    match mins {
        0 => "just now".into(),
        1..=59 => format!("{mins} min ago"),
        60..=2879 => format!("{} h ago", mins / 60),
        _ => format!("{} days ago", mins / 1440),
    }
}

/// SQL cut to SQL_CHARS, saying how long it was
fn short_sql(sql: &str) -> String {
    match sql.char_indices().nth(SQL_CHARS) {
        Some((cut, _)) => format!("{}… ({} characters)", &sql[..cut], sql.chars().count()),
        None => sql.to_string(),
    }
}

fn query_history(target: &McpSession, limit: Option<usize>, tab: Option<&str>) -> Output {
    let recorded = target.live.lock().map(|l| l.runs.clone()).unwrap_or_default();
    let runs: Vec<String> = recorded
        .iter()
        .filter(|r| tab.is_none_or(|t| r["tab"].as_str().is_some_and(|rt| rt.eq_ignore_ascii_case(t))))
        .take(limit.unwrap_or(HISTORY_RUNS).clamp(1, MAX_HISTORY_RUNS))
        .map(|r| {
            let outcome = if let Some(e) = r["error"].as_str() {
                format!("failed: {}", truncate(e))
            } else if let Some(n) = r["rows"].as_i64() {
                format!("{n} rows")
            } else if let Some(n) = r["changes"].as_i64() {
                format!("{n} rows changed")
            } else if let Some(n) = r["statements"].as_i64() {
                format!("script of {n} statements")
            } else if let Some(ddl) = r["ddl"].as_str() {
                format!("{ddl} done")
            } else {
                "done".into()
            };
            let when = match r["time"].as_str() {
                Some(time) => format!("{time} ({})", ago(r["at"].as_u64().unwrap_or(0))),
                None => ago(r["at"].as_u64().unwrap_or(0)),
            };
            let place = match (r["tab"].as_str(), r["by"].as_str()) {
                (Some(tab), Some("agent")) => format!(" · you ran it in \"{tab}\""),
                (Some(tab), _) => format!(" · the user ran it in \"{tab}\""),
                (None, Some("agent")) => " · you ran it".to_string(),
                (None, _) => " · the user ran it".to_string(),
            };
            // Each statement of a script, so a slow or empty one stands out
            let steps: String = r["steps"]
                .as_array()
                .map(|steps| {
                    steps
                        .iter()
                        .enumerate()
                        .map(|(i, st)| {
                            let result = if let Some(n) = st["rows"].as_i64() {
                                format!("{n} rows")
                            } else if let Some(n) = st["changes"].as_i64() {
                                format!("{n} rows changed")
                            } else {
                                format!("{} done", st["ddl"].as_str().unwrap_or("statement"))
                            };
                            format!(
                                "\n  {}. {result} · {} ms · {}",
                                i + 1,
                                st["ms"].as_f64().unwrap_or(0.0),
                                truncate(st["sql"].as_str().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ").as_str())
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            format!(
                "- {when} · {} ms · {outcome}{place}{steps}\n{}",
                r["ms"].as_f64().unwrap_or(0.0),
                short_sql(r["sql"].as_str().unwrap_or_default()),
            )
        })
        .collect();
    let content = if let (true, Some(tab)) = (runs.is_empty(), tab) {
        format!(
            "No runs in the tab \"{tab}\" ({} recorded on this database in other tabs).",
            recorded.len()
        )
    } else if runs.is_empty() {
        "No runs recorded on this database. The app records every run in the editor and every run of yours (the last 200, across databases), so nothing has run here yet.".to_string()
    } else {
        runs.join("\n\n")
    };
    ok(content, t_count("steps.readHistory", runs.len() as i64, &[]))
}

fn list_tables(db: &DbManager, conn_id: &str) -> Output {
    let names = |sql: &str| -> Result<Vec<String>, String> {
        Ok(db
            .query(conn_id, sql, None)?
            .rows
            .iter()
            .filter_map(|r| r.first()?.as_str().map(str::to_string))
            .filter(|t| !t.starts_with("_sys_"))
            .collect())
    };
    match (names("SHOW TABLES"), names("SHOW VIEWS")) {
        (Ok(tables), Ok(views)) => {
            // Row counts, so a size question doesn't need a check of its own
            let with_rows: Vec<Value> = tables
                .iter()
                .map(|name| {
                    let rows = db
                        .query(conn_id, &format!("SELECT COUNT(*) FROM {}", quote_id(name)), None)
                        .ok()
                        .and_then(|r| r.rows.first()?.first()?.as_i64());
                    json!({"name": name, "rows": rows})
                })
                .collect();
            ok(
                json!({"tables": with_rows, "views": views}).to_string(),
                t("steps.listed", &[("tables", &tables.len()), ("views", &views.len())]),
            )
        }
        (Err(e), _) | (_, Err(e)) => err(e),
    }
}

fn describe_table(db: &DbManager, conn_id: &str, name: &str) -> Output {
    let ddl_of = |kind: &str| {
        db.query(conn_id, &format!("SHOW CREATE {kind} {}", quote_id(name)), None)
            .ok()
            .and_then(|r| r.rows.first()?.get(1)?.as_str().map(str::to_string))
    };
    if let Some(ddl) = ddl_of("TABLE") {
        let indexes = db
            .query(conn_id, &format!("SHOW INDEXES FROM {}", quote_id(name)), None)
            .map(|r| table_text(&r.columns, &r.rows))
            .unwrap_or_default();
        return ok(
            format!("{ddl}\n\nIndexes:\n{indexes}"),
            t("steps.readSchema", &[("name", &name)]),
        );
    }
    match ddl_of("VIEW") {
        Some(ddl) => ok(ddl, t("steps.readView", &[("name", &name)])),
        None => err(format!("No table or view named {name}")),
    }
}

/// The tool result for `write_query`, from what the renderer reports about
/// running it in the tab: one statement's result, or each statement's for a
/// script.
pub fn format_run(outcome: &Value, tab: &str) -> Output {
    if outcome["ran"] != true {
        let why = outcome["reason"].as_str().unwrap_or(
            "it can change data and the user has not allowed you to run writes, so they decide whether to run it",
        );
        return ok(
            format!("Written into the tab \"{tab}\". Not run: {why}."),
            t("steps.wroteSql", &[("tab", &tab)]),
        );
    }
    if let Some(e) = outcome["error"].as_str() {
        return ok(
            format!("Written into \"{tab}\" and run. It failed: {e}"),
            t("steps.ranFailed", &[("tab", &tab), ("error", &e)]),
        );
    }
    let mut text = format!("Written into \"{tab}\" and run; the user sees the result.");
    let summary = match outcome["statements"].as_array() {
        Some(stmts) => {
            if let Some(ms) = outcome["time"].as_f64() {
                text.push_str(&format!(" The script took {ms} ms."));
            }
            for (i, st) in stmts.iter().enumerate() {
                text.push_str(&format!("\n\nStatement {}: {}", i + 1, statement_text(st)));
            }
            t_count("steps.ranStatements", stmts.len() as i64, &[("tab", &tab)])
        }
        None => {
            text.push(' ');
            text.push_str(&statement_text(outcome));
            statement_summary(outcome, tab)
        }
    };
    ok(text, summary)
}

/// One statement's result for the panel, in the app's language.
fn statement_summary(r: &Value, tab: &str) -> String {
    if let Some(n) = r["changes"].as_i64() {
        return t_count("steps.ranChanged", n, &[("tab", &tab)]);
    }
    if let Some(ddl) = r["ddl"].as_str() {
        return t("steps.ranDdl", &[("tab", &tab), ("ddl", &ddl)]);
    }
    let total = r["rowCount"].as_i64().or_else(|| r["rows"].as_array().map(|r| r.len() as i64)).unwrap_or(0);
    t_count("steps.ranRows", total, &[("tab", &tab)])
}

/// One statement's result: rows (up to MAX_ROWS), changed rows, or DDL
/// done, and how long it took.
fn statement_text(r: &Value) -> String {
    let took = r["time"].as_f64().map(|ms| format!(" in {ms} ms")).unwrap_or_default();
    if let Some(n) = r["changes"].as_i64() {
        return format!("{n} row{} changed{took}.", if n == 1 { "" } else { "s" });
    }
    if let Some(ddl) = r["ddl"].as_str() {
        return format!("{ddl} done{took}.");
    }
    let columns: Vec<String> = r["columns"]
        .as_array()
        .map(|c| c.iter().map(|v| v.as_str().unwrap_or_default().to_string()).collect())
        .unwrap_or_default();
    let rows: Vec<Vec<Value>> = r["rows"]
        .as_array()
        .map(|rs| rs.iter().map(|row| row.as_array().cloned().unwrap_or_default()).collect())
        .unwrap_or_default();
    let total = r["rowCount"].as_u64().unwrap_or(rows.len() as u64);
    let shown = &rows[..rows.len().min(MAX_ROWS)];
    let mut text = format!("{total} row{}{took}.\n{}", if total == 1 { "" } else { "s" }, table_text(&columns, shown));
    if total as usize > shown.len() {
        text.push_str(&format!("\n(first {} of {total} rows)", shown.len()));
    }
    text
}

/// Sections returned by a docs search, and the longest section text
const SEARCH_HITS: usize = 6;
const SEARCH_SECTION_CHARS: usize = 1500;

/// Rank documentation sections (split at markdown headings) by how often the
/// query's words appear, headings counting more.
fn search_docs(query: &str) -> Output {
    let terms: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| w.len() >= 2)
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return err("search_stoolap_docs needs words to look for");
    }
    let mut hits: Vec<(usize, &str, String, &str)> = Vec::new();
    for (id, _, body) in PAGES {
        for (heading, text) in sections(strip_front_matter(body)) {
            let (h, t) = (heading.to_lowercase(), text.to_lowercase());
            let mut score = 0;
            let mut matched = 0;
            for term in &terms {
                let n = t.matches(term.as_str()).count().min(5) + 3 * h.matches(term.as_str()).count();
                if n > 0 {
                    matched += 1;
                }
                score += n;
            }
            if matched > 0 {
                // Sections that contain every word rank first
                hits.push((score + matched * 10, id, heading, text));
            }
        }
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.0));
    if hits.is_empty() {
        return ok(
            format!("Nothing in the docs matches \"{query}\"."),
            t("steps.searchedDocs", &[("query", &query)]),
        );
    }
    let out = hits
        .iter()
        .take(SEARCH_HITS)
        .map(|(_, id, heading, text)| {
            let mut body: String = text.chars().take(SEARCH_SECTION_CHARS).collect();
            if text.chars().count() > SEARCH_SECTION_CHARS {
                body.push_str("\n…");
            }
            format!("### {id} › {heading}\n{body}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    ok(out, t("steps.searchedDocs", &[("query", &query)]))
}

/// A page's sections: (heading, text) at each markdown heading
fn sections(md: &str) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    let mut heading = String::new();
    let mut start = 0;
    let mut in_code = false;
    let mut offset = 0;
    for line in md.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        if !in_code && line.starts_with('#') {
            if offset > start {
                out.push((heading.clone(), md[start..offset].trim()));
            }
            heading = line.trim_start_matches('#').trim().to_string();
            start = offset + line.len();
        }
        offset += line.len();
    }
    if md.len() > start {
        out.push((heading, md[start..].trim()));
    }
    out.retain(|(_, t)| !t.is_empty());
    out
}

fn read_docs(page: &str) -> Output {
    let page = page.trim().trim_end_matches(".md").trim_start_matches('/');
    match PAGES.iter().find(|(id, _, _)| *id == page) {
        Some((_, title, body)) => ok(strip_front_matter(body).to_string(), t("steps.readDocs", &[("title", &title)])),
        None => err(format!("No page {page}. Pages: {}", page_ids().join(", "))),
    }
}

pub fn page_ids() -> Vec<&'static str> {
    PAGES.iter().map(|(id, _, _)| *id).collect()
}

/// "id — title" lines for the system prompt
pub fn page_list() -> String {
    PAGES
        .iter()
        .map(|(id, title, _)| format!("- {id}: {title}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_front_matter(md: &str) -> &str {
    md.strip_prefix("---")
        .and_then(|rest| rest.find("\n---").map(|end| rest[end + 4..].trim_start()))
        .unwrap_or(md)
}

fn cell(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::String(s) => truncate(s),
        other => truncate(&other.to_string()),
    }
}

/// `s` cut to MAX_CELL_CHARS, marked with … when cut
fn truncate(s: &str) -> String {
    if s.chars().count() > MAX_CELL_CHARS {
        let cut: String = s.chars().take(MAX_CELL_CHARS).collect();
        format!("{cut}…")
    } else {
        s.to_string()
    }
}

/// Tab-separated rows with a header line
fn table_text(columns: &[String], rows: &[Vec<Value>]) -> String {
    let mut out = columns.join("\t");
    for row in rows {
        out.push('\n');
        out.push_str(&row.iter().map(cell).collect::<Vec<_>>().join("\t"));
    }
    if rows.is_empty() {
        out.push_str("\n(no rows)");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(conn_id: &str) -> McpSession {
        let tabs = vec![
            TabSnapshot {
                id: "t1".into(),
                title: "Query 1".into(),
                sql: "-- totals\n\nSELECT SUM(x)\nFROM t".into(),
                active: true,
                ran_on: Some("other".into()),
                ran_on_name: Some("shop".into()),
                last_run_at: None,
                last_error: Some("no such column: x".into()),
            },
            TabSnapshot {
                id: "t2".into(),
                title: "Agent".into(),
                sql: String::new(),
                active: false,
                ran_on: None,
                ran_on_name: None,
                last_run_at: None,
                last_error: None,
            },
        ];
        let runs = vec![
            json!({"sql": "SELECT * FROM big", "at": 0, "time": "2026-11-18 09:00:00 +03:00", "ms": 812.5, "db": "x", "rows": 1000, "tab": "Query 1"}),
            json!({"sql": "DELETE FROM t", "at": 0, "ms": 3, "db": "x", "error": "no such table", "tab": "Agent", "by": "agent"}),
            json!({"sql": "CREATE TABLE a (id INTEGER); SELECT 1", "at": 0, "ms": 9, "db": "x", "statements": 2, "tab": "Script",
                   "steps": [{"sql": "CREATE TABLE a (id INTEGER)", "ms": 4, "ddl": "CREATE TABLE"}, {"sql": "SELECT\n  1", "ms": 1, "rows": 1}]}),
        ];
        McpSession {
            conversation_id: "c".into(),
            conn_id: conn_id.into(),
            allow_writes: false,
            tab_id: "t2".into(),
            tab_title: "Agent".into(),
            live: std::sync::Arc::new(std::sync::Mutex::new(Live { tabs, runs })),
        }
    }

    /// A tool on a connection, with the test tabs and runs
    fn run(db: &DbManager, conn_id: &str, name: &str, input: &Value) -> Output {
        super::run(db, &session(conn_id), name, input)
    }

    #[test]
    fn a_check_reads_without_leaving_anything_behind() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        db.execute(&id, "CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT)", None).unwrap();
        db.execute(&id, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'a')", None).unwrap();

        let out = run(&db, &id, "check_query", &json!({"sql": "SELECT cat, COUNT(*) AS n FROM t GROUP BY cat ORDER BY cat"}));
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("2 rows in "), "{}", out.content);
        let detail = out.detail.unwrap();
        assert_eq!(detail["rows"], json!([["a", 2], ["b", 1]]));
        assert_eq!(detail["sql"], "SELECT cat, COUNT(*) AS n FROM t GROUP BY cat ORDER BY cat");

        // Reads, SHOW and EXPLAIN (ANALYZE) of a read pass; anything that
        // writes, EXPLAIN ANALYZE of a write and several statements don't
        for sql in [
            "WITH c AS (SELECT 1 AS x) SELECT x FROM c",
            "SHOW TABLES",
            "EXPLAIN SELECT * FROM t",
            "EXPLAIN ANALYZE SELECT * FROM t WHERE cat = 'a'",
            "PRAGMA query_timeout",
        ] {
            assert!(!run(&db, &id, "check_query", &json!({"sql": sql})).is_error, "{sql}");
        }
        for sql in [
            "DELETE FROM t",
            "INSERT INTO t VALUES (9, 'z') RETURNING id",
            "PRAGMA query_timeout = 1",
            "WITH v AS (SELECT 9 AS id) INSERT INTO t SELECT id, 'z' FROM v",
            "EXPLAIN ANALYZE DELETE FROM t",
            "SELECT 1; DELETE FROM t",
            "DROP TABLE t",
            "SELECT * FROM",
        ] {
            let out = run(&db, &id, "check_query", &json!({"sql": sql}));
            assert!(out.is_error, "{sql} should be refused");
            assert_eq!(out.detail.unwrap()["sql"], sql);
        }
        let left = db.query(&id, "SELECT COUNT(*) FROM t", None).unwrap().rows;
        assert_eq!(left, vec![vec![json!(3)]]);

        // A plan is described as one, not as rows of data
        let plan = run(&db, &id, "check_query", &json!({"sql": "EXPLAIN ANALYZE SELECT * FROM t", "repeat": null}));
        assert!(plan.content.contains("A plan of "), "{}", plan.content);
        // Timing: several runs, min / median / max
        let timed = run(&db, &id, "check_query", &json!({"sql": "SELECT COUNT(*) FROM t", "repeat": 3}));
        assert!(timed.content.contains("Ran 3 times: the first (cold) run "), "{}", timed.content);
        assert_eq!(timed.detail.unwrap()["runs"], 3);
        assert!(run(&db, &id, "check_query", &json!({"sql": "SELECT 1", "repeat": 500})).content.contains("Ran 10 times"));

        let failed = run(&db, &id, "check_query", &json!({"sql": "SELECT * FROM nope"}));
        assert!(failed.is_error && failed.content.starts_with("The check failed"));
    }

    #[test]
    fn the_renderers_view_after_a_write_is_read() {
        // As lib/agent-context.ts sends it with the write's outcome
        let live: Live = serde_json::from_value(json!({
            "tabs": [{"id": "a", "title": "Sales", "sql": "SELECT 1", "active": false, "ranOn": "this", "lastRunAt": "2026-11-19 14:00:00 +03:00"}],
            "runs": [{"sql": "SELECT 1", "at": 1, "ms": 2, "db": "x", "rows": 1, "tab": "Sales", "by": "agent", "time": "2026-11-19 14:00:00 +03:00"}],
        }))
        .unwrap();
        assert_eq!(live.tabs[0].ran_on.as_deref(), Some("this"));
        assert_eq!(live.tabs[0].last_run_at.as_deref(), Some("2026-11-19 14:00:00 +03:00"));
        assert_eq!(live.runs[0]["by"], "agent");
    }

    #[test]
    fn tabs_and_runs_come_from_the_request() {
        let db = DbManager::new();
        let tabs = run(&db, "", "list_tabs", &json!({}));
        let list: Value = serde_json::from_str(&tabs.content).unwrap();
        assert_eq!(list[0]["title"], "Query 1");
        assert_eq!(list[0]["preview"], "-- totals ⏎ SELECT SUM(x)");
        assert_eq!(list[0]["last_ran_on"], "another database (shop)");
        assert_eq!(list[0]["active"], true);
        assert_eq!(list[0]["last_run_at"], "not recorded (it ran before run times were kept)");
        assert_eq!(list[0]["last_error"], "no such column: x");
        assert_eq!(list[1]["last_ran_on"], "never run");
        assert!(list[1].get("last_run_at").is_none() && list[1].get("last_error").is_none());
        assert_eq!(list[1]["yours"], true);

        assert_eq!(
            run(&db, "", "read_tab", &json!({"tab_id": "t1"})).content,
            "-- totals\n\nSELECT SUM(x)\nFROM t\n\n(The last run in this tab failed: no such column: x)"
        );
        assert!(run(&db, "", "read_tab", &json!({"tab_id": "t2"})).content.contains("is empty"));
        assert!(run(&db, "", "read_tab", &json!({"tab_id": "nope"})).is_error);

        let history = run(&db, "", "query_history", &json!({})).content;
        assert!(
            history.contains("2026-11-18 09:00:00 +03:00 (") && history.contains("812.5 ms · 1000 rows · the user ran it in \"Query 1\"\nSELECT * FROM big"),
            "{history}"
        );
        assert!(history.contains("failed: no such table · you ran it in \"Agent\""));
        assert!(history.contains("script of 2 statements · the user ran it in \"Script\"\n  1. CREATE TABLE done · 4 ms · CREATE TABLE a (id INTEGER)\n  2. 1 rows · 1 ms · SELECT 1"), "{history}");

        let one = run(&db, "", "query_history", &json!({"limit": 1, "tab": null})).content;
        assert!(one.contains("SELECT * FROM big") && !one.contains("DELETE"), "{one}");
        let in_tab = run(&db, "", "query_history", &json!({"limit": null, "tab": "agent"})).content;
        assert!(in_tab.contains("DELETE") && !in_tab.contains("big"), "{in_tab}");
        let none = run(&db, "", "query_history", &json!({"limit": null, "tab": "Nope"})).content;
        assert_eq!(none, "No runs in the tab \"Nope\" (3 recorded on this database in other tabs).");
    }

    #[test]
    fn describes_tables_and_reads_docs() {
        let db = DbManager::new();
        let meta = db.open(":memory:", None).unwrap();
        db.execute(&meta.id, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", None).unwrap();
        let d = run(&db, &meta.id, "describe_table", &json!({"name": "t"}));
        assert!(!d.is_error && d.content.contains("CREATE TABLE"));
        assert!(run(&db, &meta.id, "describe_table", &json!({"name": "nope"})).is_error);
        let tables = run(&db, &meta.id, "list_tables", &json!({}));
        assert!(tables.content.contains(r#"{"name":"t","rows":0}"#), "{}", tables.content);

        let page = run(&db, &meta.id, "read_stoolap_docs", &json!({"page": "sql-features/returning"}));
        assert!(!page.is_error && page.content.starts_with("# RETURNING"));
        assert!(run(&db, &meta.id, "read_stoolap_docs", &json!({"page": "nope"})).is_error);
        assert!(run(&db, &meta.id, "run_query", &json!({"sql": "SELECT 1"})).is_error);
    }

    #[test]
    fn search_finds_the_right_sections() {
        let upsert = search_docs("upsert duplicate key");
        assert!(upsert.content.contains("sql-features/on-duplicate-key-update"), "{}", upsert.content);
        let window = search_docs("window frame ROWS BETWEEN");
        assert!(window.content.contains("functions/window-functions"), "{}", window.content);
        assert!(search_docs("zzqqxx").content.starts_with("Nothing in the docs"));
        assert!(search_docs("  ").is_error);
    }

    #[test]
    fn describes_runs_for_the_model() {
        let rows = json!({"ran": true, "columns": ["name"], "rows": [["Alice"], ["Bob"]], "rowCount": 2, "time": 12.5});
        let out = format_run(&rows, "Agent");
        assert!(out.content.contains("Alice") && out.content.contains("2 rows in 12.5 ms."), "{}", out.content);
        assert_eq!(out.summary, "Ran it in Agent (2 rows)");

        let script = json!({"ran": true, "time": 40.2, "statements": [
            {"changes": 3, "time": 1.5},
            {"ddl": "CREATE INDEX", "time": 30},
            {"columns": ["n"], "rows": [[3]], "rowCount": 1, "time": 0.25},
        ]});
        let out = format_run(&script, "Q");
        assert!(out.content.contains("The script took 40.2 ms."), "{}", out.content);
        assert!(out.content.contains("Statement 1: 3 rows changed in 1.5 ms."));
        assert!(out.content.contains("Statement 2: CREATE INDEX done in 30 ms."));
        assert!(out.content.contains("Statement 3: 1 row in 0.25 ms."));
        // Without a time, as before
        assert!(format_run(&json!({"ran": true, "changes": 2}), "Q").content.contains("2 rows changed."));

        let failed = format_run(&json!({"ran": true, "error": "column x not found"}), "Q");
        assert!(failed.content.contains("column x not found"));
        assert!(format_run(&json!({"ran": false}), "Q").content.contains("Not run"));
    }
}
