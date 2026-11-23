use crate::db::{DbManager, ExecResult, FilterCondition};
use std::collections::HashMap;
use tauri::State;

use serde::Serialize;
use crate::i18n;

fn quote_id(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

/// Validate a raw vector literal like "[0.1, -2, 3.4]". Only digits, minus, dot,
/// comma, whitespace, and brackets are allowed. Returned as trimmed form safe to
/// inline in SQL — stoolap parses `[...]` as a vector literal.
fn sanitize_vector_literal(s: &str) -> Result<String, String> {
    let t = s.trim();
    if !t.starts_with('[') || !t.ends_with(']') {
        return Err(i18n::t("errors.vectorFormat", &[]));
    }
    for c in t.chars() {
        let ok = c.is_ascii_digit()
            || c == '.'
            || c == ','
            || c == '-'
            || c == '+'
            || c == 'e'
            || c == 'E'
            || c == '['
            || c == ']'
            || c.is_ascii_whitespace();
        if !ok {
            return Err(i18n::t("errors.vectorInvalid", &[]));
        }
    }
    Ok(t.to_string())
}

/// Build the WHERE clause and parameter list from filter conditions.
/// Values are parameterized with `?` where possible; vector literals are
/// validated and inlined because stoolap needs them in literal syntax.
fn build_where(
    filters: Option<&Vec<FilterCondition>>,
) -> Result<(String, Vec<serde_json::Value>), String> {
    let f = match filters {
        Some(f) if !f.is_empty() => f,
        _ => return Ok((String::new(), Vec::new())),
    };
    let mut clauses = Vec::new();
    let mut params: Vec<serde_json::Value> = Vec::new();
    for filter in f {
        let col = quote_id(&filter.column);
        let v = || serde_json::Value::String(filter.value.clone());
        match filter.operator.as_str() {
            "null" | "IS NULL" => clauses.push(format!("{} IS NULL", col)),
            "nnull" | "IS NOT NULL" => clauses.push(format!("{} IS NOT NULL", col)),
            "eq" => {
                clauses.push(format!("{} = ?", col));
                params.push(v());
            }
            "neq" => {
                clauses.push(format!("{} != ?", col));
                params.push(v());
            }
            "gt" => {
                clauses.push(format!("{} > ?", col));
                params.push(v());
            }
            "gte" => {
                clauses.push(format!("{} >= ?", col));
                params.push(v());
            }
            "lt" => {
                clauses.push(format!("{} < ?", col));
                params.push(v());
            }
            "lte" => {
                clauses.push(format!("{} <= ?", col));
                params.push(v());
            }
            "like" | "LIKE" => {
                clauses.push(format!("{} LIKE ?", col));
                params.push(v());
            }
            "nlike" | "NOT LIKE" => {
                clauses.push(format!("{} NOT LIKE ?", col));
                params.push(v());
            }
            "in" | "IN" => {
                let parts: Vec<&str> = filter
                    .value
                    .split('|')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                if parts.is_empty() {
                    return Err(i18n::t("errors.inNeedsValue", &[]));
                }
                let placeholders: Vec<&str> = parts.iter().map(|_| "?").collect();
                clauses.push(format!("{} IN ({})", col, placeholders.join(", ")));
                for p in parts {
                    params.push(serde_json::Value::String(p.to_string()));
                }
            }
            op @ ("cosine" | "l2" | "ip") => {
                // Vector distance filter: "[vector]|threshold"
                let pipe_idx = filter.value.rfind('|').ok_or_else(|| {
                    i18n::t("errors.vectorFilterFormat", &[])
                })?;
                let vec_part = &filter.value[..pipe_idx];
                let thresh_part = &filter.value[pipe_idx + 1..];
                let vec_lit = sanitize_vector_literal(vec_part)?;
                let threshold: f64 = thresh_part
                    .trim()
                    .parse()
                    .map_err(|_| i18n::t("errors.invalidThreshold", &[]))?;
                let fn_name = match op {
                    "cosine" => "VEC_DISTANCE_COSINE",
                    "l2" => "VEC_DISTANCE_L2",
                    "ip" => "VEC_DISTANCE_IP",
                    _ => unreachable!(),
                };
                // As parameters: the engine reads a vector from its text
                // ('[1, 2]'); a bare [1, 2] doesn't parse
                clauses.push(format!("{}({}, ?) < ?", fn_name, col));
                params.push(serde_json::Value::String(vec_lit));
                params.push(serde_json::json!(threshold));
            }
            other => return Err(format!("Unsupported filter operator: {}", other)),
        }
    }
    Ok((format!(" WHERE {}", clauses.join(" AND ")), params))
}

/// Validate `AS OF TIMESTAMP` user input. We allow only digits, dashes, colons,
/// spaces, `T`, and dot (for fractional seconds). This keeps the literal safe
/// to inline since stoolap doesn't accept `?` in the AS OF position.
fn sanitize_as_of(ts: &str) -> Result<String, String> {
    let t = ts.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    for c in t.chars() {
        let ok = c.is_ascii_digit()
            || c == '-'
            || c == ':'
            || c == ' '
            || c == 'T'
            || c == '.'
            || c == '+'
            || c == 'Z';
        if !ok {
            return Err(i18n::t("errors.invalidAsOf", &[]));
        }
    }
    Ok(format!(" AS OF TIMESTAMP '{}'", t))
}

#[derive(Debug, Serialize)]
pub struct TableRowsResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub time: f64,
}

#[derive(Debug, Serialize)]
pub struct TableCountResult {
    #[serde(rename = "totalRows")]
    pub total_rows: i64,
    pub time: f64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri commands flatten JS-call args into fn params
pub async fn db_table_rows(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    offset: i64,
    limit: i64,
    order_by: Option<String>,
    order_dir: Option<String>,
    filters: Option<Vec<FilterCondition>>,
    as_of: Option<String>,
) -> Result<TableRowsResult, String> {
    let table_ref = quote_id(&table);
    let as_of_clause = match &as_of {
        Some(ts) => sanitize_as_of(ts)?,
        None => String::new(),
    };
    let (where_clause, params) = build_where(filters.as_ref())?;
    let order_clause = match &order_by {
        Some(col) => {
            let dir = order_dir.as_deref().unwrap_or("ASC");
            format!(
                " ORDER BY {} {}",
                quote_id(col),
                if dir == "DESC" { "DESC" } else { "ASC" }
            )
        }
        None => String::new(),
    };
    let limit = limit.max(0);
    let offset = offset.max(0);
    let sql = format!(
        "SELECT * FROM {}{}{}{} LIMIT {} OFFSET {}",
        table_ref, as_of_clause, where_clause, order_clause, limit, offset
    );

    let start = std::time::Instant::now();
    let data = state.query(
        &conn_id,
        &sql,
        if params.is_empty() {
            None
        } else {
            Some(params)
        },
    )?;
    let time = start.elapsed().as_secs_f64() * 1000.0;
    let time = (time * 100.0).round() / 100.0;

    Ok(TableRowsResult {
        columns: data.columns,
        rows: data.rows,
        time,
    })
}

/// A table's rows as INSERT statements, for a SQL backup, reporting progress
/// as `backup:progress` events. Made here from the engine's values, so JSON
/// and 64-bit integers stay exact.
#[tauri::command]
pub async fn db_backup_rows(
    app: tauri::AppHandle,
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    path: String,
) -> Result<usize, String> {
    use tauri::Emitter;
    // Appended to the dump the renderer has begun at `path`, straight from
    // the engine to the file: a million rows never pass through the web view
    let db = state.get_db(&conn_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let total = DbManager::query_on(&db, &format!("SELECT COUNT(*) FROM {}", quote_id(&table)), None)?
            .rows
            .first()
            .and_then(|r| r.first())
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let file = std::fs::OpenOptions::new().append(true).open(&path).map_err(|e| e.to_string())?;
        let mut out = std::io::BufWriter::new(file);
        // About a hundred updates over the table, and the last one
        let step = (total / 100).max(1000);
        let progress = |done: usize| {
            if done.is_multiple_of(step) || done == total {
                let _ = app.emit("backup:progress", BackupProgress { done, total });
            }
        };
        let count = crate::db::write_table_inserts(&db, &table, &mut out, progress)?;
        std::io::Write::flush(&mut out).map_err(|e| e.to_string())?;
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct BackupProgress {
    done: usize,
    total: usize,
}

#[tauri::command]
pub async fn db_table_count(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    filters: Option<Vec<FilterCondition>>,
    as_of: Option<String>,
) -> Result<TableCountResult, String> {
    let table_ref = quote_id(&table);
    let as_of_clause = match &as_of {
        Some(ts) => sanitize_as_of(ts)?,
        None => String::new(),
    };
    let (where_clause, params) = build_where(filters.as_ref())?;
    let sql = format!(
        "SELECT COUNT(*) FROM {}{}{}",
        table_ref, as_of_clause, where_clause
    );

    let start = std::time::Instant::now();
    let result = state.query(
        &conn_id,
        &sql,
        if params.is_empty() {
            None
        } else {
            Some(params)
        },
    )?;
    let total_rows = result
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let time = start.elapsed().as_secs_f64() * 1000.0;
    let time = (time * 100.0).round() / 100.0;

    Ok(TableCountResult { total_rows, time })
}

#[tauri::command]
pub async fn db_insert_row(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    row: HashMap<String, serde_json::Value>,
) -> Result<ExecResult, String> {
    let cols: Vec<String> = row.keys().map(|k| quote_id(k)).collect();
    let placeholders: Vec<String> = (0..cols.len()).map(|_| "?".to_string()).collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_id(&table),
        cols.join(", "),
        placeholders.join(", ")
    );
    let params: Vec<serde_json::Value> = row.into_values().collect();
    state.execute(&conn_id, &sql, Some(params))
}

#[tauri::command]
pub async fn db_insert_rows(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    rows: Vec<HashMap<String, serde_json::Value>>,
) -> Result<ExecResult, String> {
    if rows.is_empty() {
        return Ok(ExecResult {
            changes: 0,
            time: 0.0,
        });
    }
    let cols: Vec<String> = rows[0].keys().cloned().collect();
    let col_names: Vec<String> = cols.iter().map(|k| quote_id(k)).collect();
    let placeholders: Vec<String> = (0..cols.len()).map(|_| "?".to_string()).collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_id(&table),
        col_names.join(", "),
        placeholders.join(", ")
    );

    // Run BEGIN / INSERTs / COMMIT on a clone of the handle. A clone is its own
    // session with independent transaction state, so commands running
    // concurrently on this connection neither join this transaction nor roll
    // back with it.
    let db = state.session(&*state.get_db(&conn_id)?)?;

    let start = std::time::Instant::now();
    crate::db::DbManager::execute_on(&db, "BEGIN", None)?;
    let mut total = 0i64;
    let result: Result<(), String> = (|| {
        for row in &rows {
            let params: Vec<serde_json::Value> = cols
                .iter()
                .map(|c| row.get(c).cloned().unwrap_or(serde_json::Value::Null))
                .collect();
            let r = crate::db::DbManager::execute_on(&db, &sql, Some(params))?;
            total += r.changes;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            crate::db::DbManager::execute_on(&db, "COMMIT", None)?;
        }
        Err(e) => {
            let _ = crate::db::DbManager::execute_on(&db, "ROLLBACK", None);
            return Err(e);
        }
    }
    let time = start.elapsed().as_secs_f64() * 1000.0;
    let time = (time * 100.0).round() / 100.0;
    Ok(ExecResult {
        changes: total,
        time,
    })
}

#[tauri::command]
pub async fn db_update_row(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    pk_column: String,
    pk_value: serde_json::Value,
    updates: HashMap<String, serde_json::Value>,
) -> Result<ExecResult, String> {
    let set_clauses: Vec<String> = updates
        .keys()
        .map(|col| format!("{} = ?", quote_id(col)))
        .collect();
    let mut params: Vec<serde_json::Value> = updates.into_values().collect();
    params.push(pk_value);
    let sql = format!(
        "UPDATE {} SET {} WHERE {} = ?",
        quote_id(&table),
        set_clauses.join(", "),
        quote_id(&pk_column)
    );
    state.execute(&conn_id, &sql, Some(params))
}

#[tauri::command]
pub async fn db_delete_row(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    pk_column: String,
    pk_value: serde_json::Value,
) -> Result<ExecResult, String> {
    let sql = format!(
        "DELETE FROM {} WHERE {} = ?",
        quote_id(&table),
        quote_id(&pk_column)
    );
    state.execute(&conn_id, &sql, Some(vec![pk_value]))
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub rows: i64,
    pub time: f64,
}

#[tauri::command]
pub async fn db_import_file(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    file_path: String,
    format: String,
    has_header: bool,
) -> Result<ImportResult, String> {
    let sql = copy_sql(&table, &file_path, &format, has_header)?;
    let start = std::time::Instant::now();
    let result = state.execute(&conn_id, &sql, None)?;
    let time = start.elapsed().as_secs_f64() * 1000.0;
    let time = (time * 100.0).round() / 100.0;

    Ok(ImportResult {
        rows: result.changes,
        time,
    })
}

/// The COPY statement for an import.
fn copy_sql(table: &str, file_path: &str, format: &str, has_header: bool) -> Result<String, String> {
    let fmt = format.to_uppercase();
    if fmt != "CSV" && fmt != "JSON" {
        return Err(i18n::t("errors.unsupportedFormat", &[("format", &format)]));
    }
    Ok(format!(
        "COPY {} FROM {} WITH (FORMAT {}, HEADER {})",
        quote_id(table),
        copy_path(file_path)?,
        fmt,
        if has_header { "true" } else { "false" },
    ))
}

/// A file path as COPY reads it. The lexer turns '' into ' and keeps a
/// backslash with the character after it; COPY then takes the text between
/// the quotes as is. So a quote is doubled, except right after a backslash,
/// where it is already kept; only a path ending in a lone backslash (which
/// would take the closing quote) can't be written.
fn copy_path(path: &str) -> Result<String, String> {
    let mut out = String::from("'");
    let mut chars = path.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push(c);
                out.push(chars.next().ok_or_else(|| i18n::t("errors.pathEndsInBackslash", &[]))?);
            }
            '\'' => out.push_str("''"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vector_filter_runs() {
        let db = stoolap::api::Database::open_in_memory().unwrap();
        DbManager::execute_on(&db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v VECTOR(3))", None).unwrap();
        DbManager::execute_on(&db, "INSERT INTO t VALUES (1, '[1,2,3]'), (2, '[-1,-2,-3]')", None).unwrap();
        let filters = vec![FilterCondition {
            column: "v".into(),
            operator: "cosine".into(),
            value: "[1, 2, 3]|0.5".into(),
        }];
        let (clause, params) = build_where(Some(&filters)).unwrap();
        let rows = DbManager::query_on(&db, &format!("SELECT id FROM t{clause}"), Some(params)).unwrap().rows;
        assert_eq!(rows, vec![vec![serde_json::json!(1)]]);
    }

    #[test]
    fn copy_reads_paths_with_quotes_and_backslashes() {
        let dir = std::env::temp_dir().join(format!("stoolap-copy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let names: &[&str] = if cfg!(windows) {
            &["it's.csv", "it''s.csv"]
        } else {
            &["it's.csv", "it''s.csv", r"a\b.csv", r"a\'b.csv", r"a\\'b.csv", r"a\.csv"]
        };
        let db = stoolap::api::Database::open_in_memory().unwrap();
        DbManager::execute_on(&db, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)", None).unwrap();
        for (i, name) in names.iter().enumerate() {
            let file = dir.join(name);
            std::fs::write(&file, format!("id,name\n{i},x\n")).unwrap();
            let sql = copy_sql("t", file.to_str().unwrap(), "csv", true).unwrap();
            let imported = DbManager::execute_on(&db, &sql, None).map(|r| r.changes);
            assert_eq!(imported, Ok(1), "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(copy_sql("t", r"/tmp/a\", "csv", true).is_err());
    }
}
