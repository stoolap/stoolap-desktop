use crate::db::{DbManager, ExecResult, QueryResult};
use crate::sql_utils::{classify_statement, modifies_data, split_statements, strip_comments, StatementType};
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
) -> Result<serde_json::Value, String> {
    run_script(&state, &conn_id, &sql)
}

/// Run what the editor holds: one statement, or several (DML wrapped in a
/// transaction), returning each statement's result.
pub fn run_script(
    state: &DbManager,
    conn_id: &str,
    sql: &str,
) -> Result<serde_json::Value, String> {
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

    if statements.len() == 1 {
        let result = execute_single(&db, &statements[0], None);
        note_transaction(&in_transaction, &statements[0], result.is_ok());
        return result;
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
    let result = (|| -> Result<serde_json::Value, String> {
        let total = statements.len();
        let mut results = Vec::with_capacity(total);
        for (i, stmt) in statements.iter().enumerate() {
            let r = execute_single(db, stmt, None);
            if session.is_none() {
                note_transaction(&in_transaction, stmt, r.is_ok());
            }
            let mut r = r.map_err(|e| format!("Statement {} of {total}: {e}", i + 1))?;
            r["sql"] = serde_json::Value::String(stmt.clone());
            results.push(r);
        }
        let time = (start.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
        Ok(serde_json::json!({ "results": results, "time": time }))
    })();

    match &result {
        Ok(_) => {
            if has_dml {
                DbManager::execute_on(db, "COMMIT", None)?;
            }
        }
        Err(_) => {
            if has_dml {
                let _ = DbManager::execute_on(db, "ROLLBACK", None);
            }
        }
    }

    result
}

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
) -> Result<serde_json::Value, String> {
    let start = start_override.unwrap_or_else(std::time::Instant::now);
    let stmt_type = classify_statement(stmt);

    match stmt_type {
        StatementType::Query => {
            let result = DbManager::query_on(db, stmt, None)?;
            let time = start.elapsed().as_secs_f64() * 1000.0;
            let time = (time * 100.0).round() / 100.0;
            Ok(serde_json::json!({
                "columns": result.columns,
                "rows": result.rows,
                "time": time,
            }))
        }
        StatementType::Ddl => {
            DbManager::execute_on(db, stmt, None)?;
            let time = start.elapsed().as_secs_f64() * 1000.0;
            let time = (time * 100.0).round() / 100.0;
            let words: Vec<&str> = stmt.split_whitespace().take(2).collect();
            let ddl_type = words.join(" ").to_uppercase();
            Ok(serde_json::json!({
                "ddl": ddl_type,
                "time": time,
            }))
        }
        StatementType::Dml => {
            let result = DbManager::execute_on(db, stmt, None)?;
            let time = start.elapsed().as_secs_f64() * 1000.0;
            let time = (time * 100.0).round() / 100.0;
            Ok(serde_json::json!({
                "changes": result.changes,
                "time": time,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let err = run_script(&db, &id, "INSERT INTO t VALUES (1); SELECT * FROM nope;").unwrap_err();
        assert!(err.starts_with("Statement 2 of 2:"), "{err}");
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
        run_script(&db, &id, "INSERT INTO t VALUES (1) RETURNING id; SELECT * FROM nope").unwrap_err();
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
        run_script(&db, &id, "INSERT INTO t VALUES (2); SELECT * FROM nope").unwrap_err();
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
}
