//! The agent's tools. The reading ones run here; `write_query` is
//! carried out by the renderer in the user's editor tab (see mod.rs), and
//! [format_run] turns what that run returned into the model's tool result.

use super::docs_index::PAGES;
use crate::db::DbManager;
use crate::i18n::{t, t_count};
use serde_json::{json, Value};

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
            "description": "List the tables and views in the open database.",
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
            "name": "write_query",
            "description": "Write SQL into the editor tab you work in (write_into), replacing what is there: pass the complete new content. The user watches it appear and can undo it. Reads (SELECT, WITH ... SELECT, SHOW, DESCRIBE, EXPLAIN) then run in the tab, the user sees the result grid, and you get the outcome: the error, or the columns and up to 50 rows. SQL that can change data, or several statements, runs only when the user allows writes (run_writes=\"allowed\"); otherwise it is only written and the user decides whether to run it.",
            "strict": true,
            "eager_input_streaming": true,
            "input_schema": strict_object(
                json!({
                    "sql": {"type": "string", "description": "The complete new editor content"},
                    "explanation": {"type": "string", "description": "One or two sentences on what changed and why"}
                }),
                json!(["sql", "explanation"]),
            ),
        }
    ])
}

/// What a tool produced: the text the model sees, and a short line for the UI.
pub struct Output {
    pub content: String,
    pub is_error: bool,
    pub summary: String,
}

fn ok(content: String, summary: String) -> Output {
    Output { content, is_error: false, summary }
}

fn err(message: impl Into<String>) -> Output {
    let message = message.into();
    Output { content: message.clone(), is_error: true, summary: message }
}

fn str_arg<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn quote_id(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

/// Run a tool that reads the database or the docs. `write_query` is handled
/// by the caller, which owns the UI.
pub fn run(db: &DbManager, conn_id: &str, name: &str, input: &Value) -> Output {
    match name {
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
        (Ok(tables), Ok(views)) => ok(
            json!({"tables": tables, "views": views}).to_string(),
            t("steps.listed", &[("tables", &tables.len()), ("views", &views.len())]),
        ),
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
    let s = match v {
        Value::Null => "NULL".to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.chars().count() > MAX_CELL_CHARS {
        let cut: String = s.chars().take(MAX_CELL_CHARS).collect();
        format!("{cut}…")
    } else {
        s
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

    #[test]
    fn describes_tables_and_reads_docs() {
        let db = DbManager::new();
        let meta = db.open(":memory:", None).unwrap();
        db.execute(&meta.id, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", None).unwrap();
        let d = run(&db, &meta.id, "describe_table", &json!({"name": "t"}));
        assert!(!d.is_error && d.content.contains("CREATE TABLE"));
        assert!(run(&db, &meta.id, "describe_table", &json!({"name": "nope"})).is_error);
        let tables = run(&db, &meta.id, "list_tables", &json!({}));
        assert!(tables.content.contains("\"t\""));

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
