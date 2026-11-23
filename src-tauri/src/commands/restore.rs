//! Restore from a SQL dump, read and run here rather than in the renderer: a
//! large dump (90 MB, a million rows) would otherwise go through the web view
//! whole and then back one batch of statements at a time.

use crate::db::DbManager;
use crate::i18n::t;
use crate::sql_utils::{modifies_data, split_statements_at, Located};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};

/// Set by `db_restore_cancel`; the running restore stops at its next statement
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// The error a cancelled restore ends with; the renderer, which asked for
/// the cancel, says so in the user's language
const CANCELLED_ERROR: &str = "cancelled";

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

fn read_dump(path: &str) -> Result<Vec<Located>, String> {
    let sql = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(split_statements_at(&sql))
}

/// How many statements a dump holds, for the dialog to show before it runs
#[tauri::command]
pub async fn db_restore_count(path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || read_dump(&path).map(|s| s.len()))
        .await
        .map_err(|e| e.to_string())?
}

/// Run a dump on the connection, in a session of its own (a transaction the
/// user has open in the editor is not part of it). Reports progress as
/// `restore:progress` events and returns how many statements ran.
#[tauri::command]
pub async fn db_restore(
    app: AppHandle,
    state: State<'_, DbManager>,
    conn_id: String,
    path: String,
    use_transaction: bool,
) -> Result<usize, String> {
    let db = state.session(&*state.get_db(&conn_id)?)?;
    CANCELLED.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let statements = read_dump(&path)?;
        let total = statements.len();
        // About a hundred updates over the whole restore, and the last one
        let step = (total / 100).max(1);
        run_statements(
            |sql| db.execute(sql, ()).map(|_| ()).map_err(|e| e.to_string()),
            &statements,
            use_transaction,
            || CANCELLED.load(Ordering::Relaxed),
            |done| {
                if done.is_multiple_of(step) || done == total {
                    let _ = app.emit("restore:progress", Progress { done, total });
                }
            },
        )?;
        Ok(total)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn db_restore_cancel() {
    CANCELLED.store(true, Ordering::Relaxed);
}

/// Run a dump's statements in order; the first that fails stops the restore,
/// rolling back the open transaction. With `use_transaction`, each run of
/// row statements (INSERT, UPDATE, DELETE) between other statements is one
/// transaction, committed before the next other statement.
fn run_statements(
    mut run: impl FnMut(&str) -> Result<(), String>,
    statements: &[Located],
    use_transaction: bool,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(usize),
) -> Result<(), String> {
    let mut in_transaction = false;
    let result = (|| {
        for (i, stmt) in statements.iter().enumerate() {
            if cancelled() {
                return Err(CANCELLED_ERROR.to_string());
            }
            let rows = modifies_data(&stmt.sql);
            if rows && use_transaction && !in_transaction {
                run("BEGIN")?;
                in_transaction = true;
            } else if !rows && in_transaction {
                run("COMMIT")?;
                in_transaction = false;
            }
            run(&stmt.sql).map_err(|e| statement_error(i + 1, statements.len(), stmt, &e))?;
            progress(i + 1);
        }
        if in_transaction {
            run("COMMIT")?;
            in_transaction = false;
        }
        Ok(())
    })();
    if result.is_err() && in_transaction {
        let _ = run("ROLLBACK");
    }
    result
}

/// A statement's error as the dump's reader needs it: which statement, the
/// line of the file it starts on and how it begins, then the engine's error
/// with its position (counted from the statement) moved into the file.
fn statement_error(n: usize, total: usize, stmt: &Located, error: &str) -> String {
    let words: Vec<&str> = stmt.sql.split_whitespace().collect();
    let mut start = words.join(" ");
    if let Some((cut, _)) = start.char_indices().nth(60) {
        start.truncate(cut);
        start.push('…');
    }
    let heading = t(
        "errors.restoreStatement",
        &[("n", &n), ("total", &total), ("line", &stmt.line), ("start", &start)],
    );
    format!("{heading}\n{}", in_file(error, stmt))
}

/// The engine's "line L, column C", counted from the statement's start,
/// rewritten as where that is in the file
fn in_file(error: &str, stmt: &Located) -> String {
    let number = |s: &str| -> Option<(usize, usize)> {
        let len = s.bytes().take_while(u8::is_ascii_digit).count();
        Some((s[..len].parse().ok()?, len))
    };
    let Some(at) = error.find("line ") else { return error.to_string() };
    let after_line = &error[at + 5..];
    let Some((line, line_len)) = number(after_line) else { return error.to_string() };
    let Some(rest) = after_line[line_len..].strip_prefix(", column ") else { return error.to_string() };
    let Some((column, column_len)) = number(rest) else { return error.to_string() };
    let file_line = stmt.line + line.saturating_sub(1);
    let file_column = if line <= 1 { stmt.column + column.saturating_sub(1) } else { column };
    let end = at + 5 + line_len + ", column ".len() + column_len;
    format!("{}line {file_line}, column {file_column}{}", &error[..at], &error[end..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbManager;
    use stoolap::api::Database;

    fn statements(sql: &[&str]) -> Vec<Located> {
        sql.iter().map(|s| Located { sql: s.to_string(), line: 1, column: 1 }).collect()
    }

    /// The statements run, failing on the one equal to `fail`
    fn record(
        list: &[Located],
        use_transaction: bool,
        fail: Option<&str>,
    ) -> (Vec<String>, Result<(), String>) {
        let mut ran = Vec::new();
        let result = run_statements(
            |sql| {
                ran.push(sql.to_string());
                if Some(sql) == fail { Err("boom".into()) } else { Ok(()) }
            },
            list,
            use_transaction,
            || false,
            |_| {},
        );
        (ran, result)
    }

    #[test]
    fn keeps_the_files_order_without_a_transaction() {
        let list = statements(&["CREATE TABLE t (a INTEGER)", "INSERT INTO t VALUES (1)", "CREATE INDEX i ON t (a)"]);
        let (ran, result) = record(&list, false, None);
        assert!(result.is_ok());
        assert_eq!(ran, list.iter().map(|s| s.sql.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn wraps_each_run_of_rows_in_a_transaction() {
        let list = statements(&[
            "CREATE TABLE t (a INTEGER)",
            "INSERT INTO t VALUES (1)",
            "INSERT INTO t VALUES (2)",
            "CREATE INDEX i ON t (a)",
            "INSERT INTO t VALUES (3)",
        ]);
        let (ran, result) = record(&list, true, None);
        assert!(result.is_ok());
        assert_eq!(
            ran,
            [
                "CREATE TABLE t (a INTEGER)",
                "BEGIN",
                "INSERT INTO t VALUES (1)",
                "INSERT INTO t VALUES (2)",
                "COMMIT",
                "CREATE INDEX i ON t (a)",
                "BEGIN",
                "INSERT INTO t VALUES (3)",
                "COMMIT",
            ]
        );
    }

    #[test]
    fn stops_at_a_failure_and_rolls_back() {
        let list = statements(&["CREATE TABLE t (a INTEGER)", "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)", "INSERT INTO t VALUES (3)"]);
        let (ran, result) = record(&list, true, Some("INSERT INTO t VALUES (2)"));
        let error = result.unwrap_err();
        assert!(error.starts_with("Statement 3 of 4, line 1: INSERT INTO t VALUES (2)\n"), "{error}");
        assert!(error.ends_with("boom"), "{error}");
        assert_eq!(ran, ["CREATE TABLE t (a INTEGER)", "BEGIN", "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)", "ROLLBACK"]);
    }

    #[test]
    fn points_an_error_into_the_file() {
        let stmt = Located { sql: "CREATE TABLE t (a INTEGER)\nCREATE".into(), line: 37, column: 5 };
        let error = "parse error: expected ';' or end of input, got 'CREATE' at position line 2, column 1";
        assert!(in_file(error, &stmt).ends_with("at position line 38, column 1"));
        // On the statement's first line, its column counts from where it starts
        let error = "parse error at position line 1, column 9";
        assert!(in_file(error, &stmt).ends_with("line 37, column 13"));
        assert_eq!(in_file("no position here", &stmt), "no position here");
    }

    #[test]
    fn stops_when_asked_to() {
        let list = statements(&["CREATE TABLE t (a INTEGER)", "INSERT INTO t VALUES (1)"]);
        let result = run_statements(|_| Ok(()), &list, true, || true, |_| {});
        assert_eq!(result, Err(CANCELLED_ERROR.into()));
    }

    #[test]
    fn restores_a_dump_into_the_engine() {
        let db = Database::open_in_memory().unwrap();
        let mut sql = String::from("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n");
        for i in 0..1000 {
            sql.push_str(&format!("INSERT INTO t VALUES ({i}, 'row; {i}');\n"));
        }
        sql.push_str("CREATE INDEX idx_name ON t (name);\n");
        let list = split_statements_at(&sql);
        assert_eq!(list.len(), 1002);
        let mut last = 0;
        run_statements(
            |s| db.execute(s, ()).map(|_| ()).map_err(|e| e.to_string()),
            &list,
            true,
            || false,
            |done| last = done,
        )
        .unwrap();
        assert_eq!(last, 1002);
        let rows = DbManager::query_on(&db, "SELECT COUNT(*) FROM t", None).unwrap();
        assert_eq!(rows.rows[0][0], 1000);
    }
}
