use crate::db::{DbManager, ExecResult, QueryResult};
use crate::sql_utils::{classify_statement, split_statements, strip_comments, StatementType};
use stoolap::api::Database;
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
    let cleaned = strip_comments(&sql);
    if cleaned.is_empty() {
        return Err("Empty query".to_string());
    }

    let statements = split_statements(&cleaned);
    if statements.is_empty() {
        return Err("Empty query".to_string());
    }

    // Share the connection's Database instance (not a clone — stoolap clones
    // spin up a fresh executor with independent transaction state) so the
    // BEGIN/COMMIT wrapper covers every statement in the script, and so any
    // transaction the user opened in a previous call is still visible here.
    let db = state.get_db(&conn_id)?;

    if statements.len() == 1 {
        return execute_single(&db, &statements[0], None);
    }

    let start = std::time::Instant::now();
    let types: Vec<StatementType> = statements.iter().map(|s| classify_statement(s)).collect();

    let has_explicit_txn = statements.iter().any(|s| {
        let u = s.trim_start().to_uppercase();
        u.starts_with("BEGIN")
            || u.starts_with("COMMIT")
            || u.starts_with("ROLLBACK")
            || u.starts_with("SAVEPOINT")
    });
    let has_dml = !has_explicit_txn && types.contains(&StatementType::Dml);

    if has_dml {
        DbManager::execute_on(&db, "BEGIN", None)?;
    }

    let result = (|| -> Result<serde_json::Value, String> {
        for (stmt, stmt_type) in statements
            .iter()
            .zip(types.iter())
            .take(statements.len() - 1)
        {
            match stmt_type {
                StatementType::Query => {
                    DbManager::query_on(&db, stmt, None)?;
                }
                _ => {
                    DbManager::execute_on(&db, stmt, None)?;
                }
            }
        }
        execute_single(&db, statements.last().unwrap(), Some(start))
    })();

    match &result {
        Ok(_) => {
            if has_dml {
                DbManager::execute_on(&db, "COMMIT", None)?;
            }
        }
        Err(_) => {
            if has_dml {
                let _ = DbManager::execute_on(&db, "ROLLBACK", None);
            }
        }
    }

    result
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
