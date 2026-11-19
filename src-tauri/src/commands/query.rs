use crate::db::{DbManager, ExecResult, QueryResult, ResultRows};
use crate::sql_utils::{classify_statement, modifies_data, split_statements, strip_comments, StatementType};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use stoolap::api::Database;
use stoolap::parser::ast::Statement;
use tauri::State;

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbManager>,
    conn_id: String,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
) -> Result<QueryResult, String> {
    state.query(&conn_id, &sql, params)
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, DbManager>,
    conn_id: String,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
) -> Result<ExecResult, String> {
    state.execute(&conn_id, &sql, params)
}

#[tauri::command]
pub async fn db_execute_query(
    state: State<'_, DbManager>,
    conn_id: String,
    sql: String,
) -> Result<RunOutput, String> {
    run_script(&state, &conn_id, &sql)
}

/// Whether the connection's session is inside a transaction the user began
#[tauri::command]
pub async fn db_transaction_open(state: State<'_, DbManager>, conn_id: String) -> Result<bool, String> {
    Ok(state.transaction_state(&conn_id)?.load(Ordering::Relaxed))
}

/// One statement's result, as the renderer reads it
#[derive(Serialize)]
#[serde(untagged)]
pub enum StatementResult {
    Query { columns: Vec<String>, rows: ResultRows, time: f64 },
    Ddl { ddl: String, time: f64 },
    Exec { changes: i64, time: f64 },
}

/// A script's statement: its result and its SQL
#[derive(Serialize)]
pub struct ScriptStatement {
    #[serde(flatten)]
    result: StatementResult,
    sql: String,
}

/// What running the editor's SQL returns: one statement's result, or each
/// statement's for a script
#[derive(Serialize)]
#[serde(untagged)]
pub enum RunOutput {
    Single(StatementResult),
    /// `error`: the statement that failed, after the ones that ran
    Script {
        results: Vec<ScriptStatement>,
        time: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// The statement that failed, and the ones after it that didn't run
        #[serde(skip_serializing_if = "Option::is_none")]
        failed: Option<String>,
        #[serde(rename = "notRun", skip_serializing_if = "Vec::is_empty")]
        not_run: Vec<String>,
        /// What ran before the failure was rolled back with it
        #[serde(rename = "rolledBack", skip_serializing_if = "std::ops::Not::not")]
        rolled_back: bool,
    },
}

/// Run what the editor holds: one statement, or several (DML wrapped in a
/// transaction), returning each statement's result.
pub fn run_script(
    state: &DbManager,
    conn_id: &str,
    sql: &str,
) -> Result<RunOutput, String> {
    let cleaned = strip_comments(sql);
    if cleaned.is_empty() {
        return Err("Empty query".to_string());
    }

    let statements = split_statements(&cleaned);
    if statements.is_empty() {
        return Err("Empty query".to_string());
    }

    // Share the connection's Database instance (not a clone — stoolap clones
    // are separate sessions with independent transaction state) so a
    // transaction the user opened in a previous call is still visible here.
    let db = state.get_db(conn_id)?;
    let in_transaction = state.transaction_state(conn_id)?;

    // A transaction from an earlier run that this run joins
    let was_open = in_transaction.load(Ordering::Relaxed);

    if statements.len() == 1 {
        let result = execute_single(&db, &statements[0], None);
        note_transaction(&in_transaction, &statements[0], result.is_ok());
        return result.map(RunOutput::Single).map_err(|e| {
            if in_transaction.load(Ordering::Relaxed) { format!("{}{STILL_OPEN}", sentence(e)) } else { e }
        });
    }

    let start = std::time::Instant::now();

    let has_explicit_txn = statements.iter().any(|s| {
        let u = s.trim_start().to_uppercase();
        u.starts_with("BEGIN")
            || u.starts_with("COMMIT")
            || u.starts_with("ROLLBACK")
            || u.starts_with("SAVEPOINT")
    });
    // Inside a transaction the user opened, the script joins it instead
    let has_dml = !has_explicit_txn
        && !in_transaction.load(Ordering::Relaxed)
        && statements.iter().any(|s| modifies_data(s));

    // The BEGIN/COMMIT wrapper runs on a clone of the handle, its own
    // session: commands running concurrently on this connection neither join
    // the wrapper transaction nor roll back with it, and the wrapper's COMMIT
    // no longer commits a transaction the user left open on the connection.
    let session = if has_dml { Some(state.session(&db)?) } else { None };
    let db: &Database = session.as_ref().unwrap_or(&db);

    if has_dml {
        DbManager::execute_on(db, "BEGIN", None)?;
    }

    // Every statement's result, so the UI can show each one, not only the last
    // Every statement's result, so the UI can show each one, not only the
    // last; a failure keeps the ones that ran before it
    let total = statements.len();
    let mut results = Vec::with_capacity(total);
    let mut failure = None;
    let mut failed = None;
    let mut not_run = Vec::new();
    for (i, stmt) in statements.iter().enumerate() {
        let r = execute_single(db, stmt, None);
        if session.is_none() {
            note_transaction(&in_transaction, stmt, r.is_ok());
        }
        match r {
            Ok(result) => results.push(ScriptStatement { result, sql: stmt.clone() }),
            Err(e) => {
                // What didn't run is as much the outcome as what did
                let unrun = match total - (i + 1) {
                    0 => String::new(),
                    1 => " The statement after it did not run.".to_string(),
                    n => format!(" The {n} statements after it did not run."),
                };
                failure = Some(format!("Statement {} of {total}: {}{unrun}", i + 1, sentence(e)));
                failed = Some(stmt.clone());
                not_run = statements[i + 1..].to_vec();
                break;
            }
        }
    }
    let time = (start.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;

    let Some(mut error) = failure else {
        if has_dml {
            DbManager::execute_on(db, "COMMIT", None)?;
        }
        return Ok(RunOutput::Script { results, time, error: None, failed: None, not_run, rolled_back: false });
    };
    // Say what became of the transaction, and never leave one the user
    // didn't open behind
    let mut rolled_back = false;
    if has_dml {
        let _ = DbManager::execute_on(db, "ROLLBACK", None);
        rolled_back = true;
        error.push_str(SCRIPT_ROLLED_BACK);
    } else if !was_open && in_transaction.load(Ordering::Relaxed) {
        // The script began a transaction and stopped before its own COMMIT
        // or ROLLBACK: left open, every later run would join it unawares
        let _ = DbManager::execute_on(db, "ROLLBACK", None);
        in_transaction.store(false, Ordering::Relaxed);
        rolled_back = true;
        error.push_str(BEGUN_ROLLED_BACK);
    } else if in_transaction.load(Ordering::Relaxed) {
        error.push_str(STILL_OPEN);
    }
    if results.is_empty() {
        return Err(error);
    }
    Ok(RunOutput::Script { results, time, error: Some(error), failed, not_run, rolled_back })
}

/// An engine error as a sentence, so what is added after it reads apart
fn sentence(mut e: String) -> String {
    if !e.trim_end().ends_with(['.', '!', '?']) {
        e.push('.');
    }
    e
}

/// Added to a failed script's error: what became of what it did
pub const SCRIPT_ROLLED_BACK: &str = " Nothing this script did was kept: it ran in a transaction that was rolled back.";
pub const BEGUN_ROLLED_BACK: &str = " The transaction the script began was rolled back.";

/// Added to an error that leaves the user's own transaction open
pub const STILL_OPEN: &str = " The transaction is still open: run COMMIT or ROLLBACK to end it.";

/// Follow BEGIN, COMMIT and ROLLBACK run on the connection's own handle.
/// They are read with the engine's own parser: one it can't parse never ran
/// and leaves the transaction as it was. A COMMIT or ROLLBACK that parsed
/// ends the transaction even when it fails (a COMMIT that hits a write
/// conflict leaves none open); ROLLBACK TO a savepoint keeps it.
fn note_transaction(in_transaction: &AtomicBool, stmt: &str, succeeded: bool) {
    let head = stmt.trim_start().get(..8).unwrap_or(stmt).to_uppercase();
    if !["BEGIN", "COMMIT", "ROLLBACK"].iter().any(|k| head.starts_with(k)) {
        return;
    }
    let Ok(parsed) = stoolap::parser::parse_sql(stmt) else { return };
    match parsed.first() {
        Some(Statement::Begin(_)) if succeeded => in_transaction.store(true, Ordering::Relaxed),
        Some(Statement::Commit(_)) => in_transaction.store(false, Ordering::Relaxed),
        Some(Statement::Rollback(r)) if r.savepoint_name.is_none() => in_transaction.store(false, Ordering::Relaxed),
        _ => {}
    }
}

fn execute_single(
    db: &Database,
    stmt: &str,
    start_override: Option<std::time::Instant>,
) -> Result<StatementResult, String> {
    let start = start_override.unwrap_or_else(std::time::Instant::now);
    let stmt_type = classify_statement(stmt);

    match stmt_type {
        StatementType::Query => {
            let result = DbManager::query_rows_on(db, stmt, None)?;
            let time = start.elapsed().as_secs_f64() * 1000.0;
            let time = (time * 100.0).round() / 100.0;
            Ok(StatementResult::Query { columns: result.columns, rows: result.rows, time })
        }
        StatementType::Ddl => {
            DbManager::execute_on(db, stmt, None)?;
            let time = start.elapsed().as_secs_f64() * 1000.0;
            let time = (time * 100.0).round() / 100.0;
            let words: Vec<&str> = stmt.split_whitespace().take(2).collect();
            let ddl_type = words.join(" ").to_uppercase();
            Ok(StatementResult::Ddl { ddl: ddl_type, time })
        }
        StatementType::Dml => {
            let result = DbManager::execute_on(db, stmt, None)?;
            let time = start.elapsed().as_secs_f64() * 1000.0;
            let time = (time * 100.0).round() / 100.0;
            Ok(StatementResult::Exec { changes: result.changes, time })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// run_script's output as the renderer receives it
    fn run_script(db: &DbManager, id: &str, sql: &str) -> Result<serde_json::Value, String> {
        super::run_script(db, id, sql).map(|out| serde_json::to_value(out).unwrap())
    }

    #[test]
    fn a_script_returns_every_statements_result() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        let out = run_script(
            &db,
            &id,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n\
             INSERT INTO t VALUES (1, 'a'), (2, 'b');\n\
             SELECT name FROM t ORDER BY id;\n\
             SELECT COUNT(*) AS n FROM t;",
        )
        .unwrap();
        let results = out["results"].as_array().unwrap();
        assert_eq!(results.len(), 4);
        assert_eq!(results[0]["ddl"], "CREATE TABLE");
        assert_eq!(results[1]["changes"], 2);
        assert_eq!(results[2]["rows"], serde_json::json!([["a"], ["b"]]));
        assert_eq!(results[3]["columns"], serde_json::json!(["n"]));
        assert_eq!(results[3]["sql"], "SELECT COUNT(*) AS n FROM t");
    }

    #[test]
    fn a_failing_statement_is_named_and_rolls_back() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        let out = run_script(&db, &id, "INSERT INTO t VALUES (1); SELECT * FROM nope;").unwrap();
        let err = out["error"].as_str().unwrap();
        assert!(err.starts_with("Statement 2 of 2:") && err.ends_with("rolled back."), "{err}");
        // The statement before the failure still shows its result
        assert_eq!(out["results"][0]["changes"], 1);
        let rows = run_script(&db, &id, "SELECT COUNT(*) FROM t").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[0]]));
    }

    #[test]
    fn a_script_joins_a_transaction_the_user_opened() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        run_script(&db, &id, "BEGIN").unwrap();
        run_script(&db, &id, "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)").unwrap();
        run_script(&db, &id, "ROLLBACK").unwrap();
        let rows = run_script(&db, &id, "SELECT COUNT(*) FROM t").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[0]]));

        // After the ROLLBACK, scripts get their own transaction again
        run_script(&db, &id, "INSERT INTO t VALUES (3); INSERT INTO t VALUES (4)").unwrap();
        let rows = run_script(&db, &id, "SELECT COUNT(*) FROM t").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[2]]));
    }

    #[test]
    fn a_write_with_returning_rolls_back_with_its_script() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        let out = run_script(&db, &id, "INSERT INTO t VALUES (1) RETURNING id; SELECT * FROM nope").unwrap();
        assert!(out["error"].is_string());
        let rows = run_script(&db, &id, "SELECT COUNT(*) FROM t").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[0]]));
    }

    #[test]
    fn a_cte_write_with_returning_returns_its_rows() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        let out = run_script(&db, &id, "WITH v AS (SELECT 7 AS id) INSERT INTO t SELECT id FROM v RETURNING id").unwrap();
        assert_eq!(out["rows"], serde_json::json!([[7]]));
    }

    #[test]
    fn a_failed_commit_ends_the_transaction() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        run_script(&db, &id, "BEGIN").unwrap();
        run_script(&db, &id, "INSERT INTO t VALUES (1)").unwrap();
        // Another session takes the same key first, so the COMMIT conflicts
        let other = db.session(&db.get_db(&id).unwrap()).unwrap();
        DbManager::execute_on(&other, "INSERT INTO t VALUES (1)", None).unwrap();
        run_script(&db, &id, "COMMIT").unwrap_err();

        // No transaction is open now, so a failing script rolls itself back
        let out = run_script(&db, &id, "INSERT INTO t VALUES (2); SELECT * FROM nope").unwrap();
        assert!(out["error"].is_string());
        let rows = run_script(&db, &id, "SELECT id FROM t ORDER BY id").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[1]]));
    }

    #[test]
    fn rolling_back_to_a_savepoint_keeps_the_transaction() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        for stmt in ["BEGIN", "SAVEPOINT s1", "ROLLBACK TRANSACTION TO SAVEPOINT s1"] {
            run_script(&db, &id, stmt).unwrap();
        }
        run_script(&db, &id, "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)").unwrap();
        run_script(&db, &id, "ROLLBACK").unwrap();
        let rows = run_script(&db, &id, "SELECT COUNT(*) FROM t").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[0]]));
    }

    #[test]
    fn a_commit_that_does_not_parse_keeps_the_transaction() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE t (id INTEGER PRIMARY KEY)").unwrap();
        run_script(&db, &id, "BEGIN").unwrap();
        run_script(&db, &id, "INSERT INTO t VALUES (1)").unwrap();
        run_script(&db, &id, "COMMIT INVALID").unwrap_err();
        run_script(&db, &id, "ROLLBACK INVALID").unwrap_err();
        run_script(&db, &id, "INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)").unwrap();
        run_script(&db, &id, "ROLLBACK").unwrap();
        let rows = run_script(&db, &id, "SELECT COUNT(*) FROM t").unwrap();
        assert_eq!(rows["rows"], serde_json::json!([[0]]));
    }

    #[test]
    fn a_failed_script_never_leaves_its_own_transaction_open() {
        let db = DbManager::new();
        let id = db.open(":memory:", None).unwrap().id;
        run_script(&db, &id, "CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id))").unwrap();
        run_script(&db, &id, "INSERT INTO p VALUES (1)").unwrap();
        let open = || db.transaction_state(&id).unwrap().load(Ordering::Relaxed);

        // It began its transaction and failed before its own ROLLBACK
        let out = run_script(&db, &id, "BEGIN; INSERT INTO p VALUES (2) RETURNING id; INSERT INTO c VALUES (1, 99); ROLLBACK").unwrap();
        let err = out["error"].as_str().unwrap();
        assert!(err.starts_with("Statement 3 of 4:") && err.ends_with("The statement after it did not run. The transaction the script began was rolled back."), "{err}");
        assert_eq!(out["results"][1]["rows"], serde_json::json!([[2]]), "the statements before it still show");
        assert_eq!(out["failed"], "INSERT INTO c VALUES (1, 99)");
        assert_eq!(out["notRun"], serde_json::json!(["ROLLBACK"]));
        assert_eq!(out["rolledBack"], true);
        assert!(err.contains("does not exist. The statement after it"), "a sentence apart: {err}");
        assert!(!open());
        assert_eq!(run_script(&db, &id, "SELECT COUNT(*) FROM p").unwrap()["rows"], serde_json::json!([[1]]));

        // A transaction the user opened earlier is theirs: it stays, and the error says so
        run_script(&db, &id, "BEGIN").unwrap();
        let out = run_script(&db, &id, "INSERT INTO p VALUES (3); INSERT INTO c VALUES (1, 99)").unwrap();
        assert!(out["error"].as_str().unwrap().ends_with("run COMMIT or ROLLBACK to end it."));
        assert!(open());
        let single = run_script(&db, &id, "INSERT INTO c VALUES (1, 99)").unwrap_err();
        assert!(single.ends_with("run COMMIT or ROLLBACK to end it."), "{single}");
        run_script(&db, &id, "ROLLBACK").unwrap();
        assert!(!open());
    }
}
