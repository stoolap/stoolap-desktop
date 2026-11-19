use crate::db::{ColumnInfo, DbManager, ForeignKeyInfo, IndexInfo};
use tauri::State;

fn quote_id(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, DbManager>,
    conn_id: String,
) -> Result<Vec<String>, String> {
    let result = state.query(&conn_id, "SHOW TABLES", None)?;
    Ok(result
        .rows
        .iter()
        .filter_map(|r| r.first().and_then(|v| v.as_str().map(|s| s.to_string())))
        // Hide the engine's statistics tables (_sys_table_stats, ... after ANALYZE)
        .filter(|t| !t.starts_with("_sys_"))
        .collect())
}

#[tauri::command]
pub async fn db_views(state: State<'_, DbManager>, conn_id: String) -> Result<Vec<String>, String> {
    let result = state.query(&conn_id, "SHOW VIEWS", None)?;
    Ok(result
        .rows
        .iter()
        .filter_map(|r| r.first().and_then(|v| v.as_str().map(|s| s.to_string())))
        .collect())
}

#[tauri::command]
pub async fn db_describe(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
    schema_type: String,
) -> Result<Vec<ColumnInfo>, String> {
    if schema_type == "view" {
        // Views don't have a DESCRIBE equivalent in stoolap, so we infer
        // column types from the first row. Columns whose first value is NULL
        // fall back to TEXT.
        let sql = format!("SELECT * FROM {} LIMIT 1", quote_id(&table));
        let result = state.query(&conn_id, &sql, None)?;
        let first = result.rows.first();
        return Ok(result
            .columns
            .iter()
            .enumerate()
            .map(|(i, col)| {
                let col_type = first
                    .and_then(|r| r.get(i))
                    .map(infer_json_type)
                    .unwrap_or("TEXT");
                ColumnInfo {
                    field: col.clone(),
                    col_type: col_type.to_string(),
                    nullable: true,
                    key: String::new(),
                    default_value: String::new(),
                    extra: String::new(),
                }
            })
            .collect());
    }

    let sql = format!("DESCRIBE {}", quote_id(&table));
    let result = state.query(&conn_id, &sql, None)?;
    Ok(result
        .rows
        .iter()
        .map(|row| {
            let get_str = |i: usize| {
                row.get(i)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            ColumnInfo {
                field: get_str(0),
                col_type: get_str(1),
                nullable: get_str(2) == "YES",
                key: get_str(3),
                default_value: get_str(4),
                extra: get_str(5),
            }
        })
        .collect())
}

/// The columns of an index as SHOW INDEXES writes them: one name, or
/// "(a, b, c)" for several. The engine writes the names unquoted and joins
/// them with ", ", so a name holding a comma without a space ("a,b") stays
/// whole; one holding ", " can't be told apart from two columns.
fn index_columns(listed: &str) -> Vec<String> {
    let listed = listed.trim();
    match listed.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        Some(inner) => inner.split(", ").map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect(),
        None => vec![listed.to_string()],
    }
}

#[tauri::command]
pub async fn db_indexes(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let sql = format!("SHOW INDEXES FROM {}", quote_id(&table));
    let result = state.query(&conn_id, &sql, None)?;
    Ok(result
        .rows
        .iter()
        .map(|row| {
            let get_str = |i: usize| {
                row.get(i)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let is_unique = row
                .get(4)
                .map(|v| {
                    v.as_bool().unwrap_or(false)
                        || v.as_i64() == Some(1)
                        || v.as_str() == Some("true")
                })
                .unwrap_or(false);
            IndexInfo {
                table_name: get_str(0),
                index_name: get_str(1),
                columns: index_columns(&get_str(2)),
                column_name: get_str(2),
                index_type: get_str(3),
                is_unique,
                options: get_str(5),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn db_fks(
    state: State<'_, DbManager>,
    conn_id: String,
    table: String,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!("SHOW CREATE TABLE {}", quote_id(&table));
    let result = state.query(&conn_id, &sql, None)?;
    if result.rows.is_empty() {
        return Ok(Vec::new());
    }
    let ddl = result.rows[0]
        .get(1)
        .or(result.rows[0].first())
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(parse_foreign_keys(ddl))
}

#[tauri::command]
pub async fn db_ddl(
    state: State<'_, DbManager>,
    conn_id: String,
    name: String,
    schema_type: String,
) -> Result<String, String> {
    let keyword = if schema_type == "view" {
        "VIEW"
    } else {
        "TABLE"
    };
    let sql = format!("SHOW CREATE {} {}", keyword, quote_id(&name));
    let result = state.query(&conn_id, &sql, None)?;
    if result.rows.is_empty() {
        return Ok(String::new());
    }
    Ok(result.rows[0]
        .get(1)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

fn infer_json_type(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Bool(_) => "BOOLEAN",
        serde_json::Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                "INTEGER"
            } else {
                "FLOAT"
            }
        }
        serde_json::Value::String(s) => {
            // Heuristic for timestamp strings (RFC3339-ish)
            if s.len() >= 10
                && s.as_bytes()[4] == b'-'
                && s.as_bytes()[7] == b'-'
                && s.chars().take(4).all(|c| c.is_ascii_digit())
            {
                "TIMESTAMP"
            } else {
                "TEXT"
            }
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => "JSON",
        serde_json::Value::Null => "TEXT",
    }
}

fn parse_foreign_keys(ddl: &str) -> Vec<ForeignKeyInfo> {
    let mut fks = Vec::new();
    // SHOW CREATE TABLE prints the whole table on one line, so cut the DDL at
    // each FOREIGN KEY clause, not at line breaks. ASCII uppercasing keeps
    // byte offsets equal to the original's, so they can index it.
    let upper_ddl = ddl.to_ascii_uppercase();
    let starts: Vec<usize> = upper_ddl
        .match_indices("FOREIGN KEY")
        .map(|(i, _)| i)
        .collect();
    for (n, &start) in starts.iter().enumerate() {
        let end = starts.get(n + 1).copied().unwrap_or(ddl.len());
        let line = &ddl[start..end];
        let trimmed = line.trim().to_ascii_uppercase();
        if !trimmed.contains("FOREIGN KEY") || !trimmed.contains("REFERENCES") {
            continue;
        }
        let line_trimmed = line.trim();
        // Extract column name from FOREIGN KEY ("col")
        if let Some(fk_start) = line_trimmed.find("FOREIGN KEY") {
            let after_fk = &line_trimmed[fk_start + 11..];
            let col = extract_paren_id(after_fk);
            // Extract referenced table and column from REFERENCES "table" ("col")
            if let Some(ref_start) = line_trimmed.to_ascii_uppercase().find("REFERENCES") {
                let after_ref = &line_trimmed[ref_start + 10..].trim_start();
                let (ref_table, rest) = extract_id(after_ref);
                let ref_col = extract_paren_id(rest);
                let upper = line_trimmed.to_ascii_uppercase();
                let on_delete = extract_action(&upper, "ON DELETE");
                let on_update = extract_action(&upper, "ON UPDATE");
                if !col.is_empty() && !ref_table.is_empty() {
                    fks.push(ForeignKeyInfo {
                        column_name: col,
                        referenced_table: ref_table,
                        referenced_column: if ref_col.is_empty() {
                            "id".to_string()
                        } else {
                            ref_col
                        },
                        on_delete,
                        on_update,
                    });
                }
            }
        }
    }
    fks
}

fn extract_paren_id(s: &str) -> String {
    if let Some(open) = s.find('(') {
        let after = &s[open + 1..];
        if let Some(close) = after.find(')') {
            let inner = after[..close].trim();
            return inner.trim_matches('"').trim_matches('`').to_string();
        }
    }
    String::new()
}

fn extract_id(s: &str) -> (String, &str) {
    let s = s.trim_start();
    if let Some(after_quote) = s.strip_prefix('"') {
        if let Some(end) = after_quote.find('"') {
            return (after_quote[..end].to_string(), &after_quote[end + 1..]);
        }
    }
    let end = s
        .find(|c: char| c == '(' || c.is_whitespace())
        .unwrap_or(s.len());
    (s[..end].trim_matches('`').to_string(), &s[end..])
}

fn extract_action(upper: &str, keyword: &str) -> String {
    if let Some(pos) = upper.find(keyword) {
        let after = upper[pos + keyword.len()..].trim_start();
        let actions = [
            "CASCADE",
            "SET NULL",
            "SET DEFAULT",
            "RESTRICT",
            "NO ACTION",
        ];
        for action in &actions {
            if after.starts_with(action) {
                return action.to_string();
            }
        }
    }
    "NO ACTION".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_foreign_key_on_one_line() {
        // The shape SHOW CREATE TABLE prints in Stoolap 0.5.0
        let ddl = "CREATE TABLE orders (id Integer PRIMARY KEY AUTO_INCREMENT, \
                   customer_id Integer NOT NULL, product_id Integer NOT NULL, \
                   FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE RESTRICT, \
                   FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE ON UPDATE RESTRICT)";
        let fks = parse_foreign_keys(ddl);
        assert_eq!(fks.len(), 2);
        assert_eq!(fks[0].column_name, "customer_id");
        assert_eq!(fks[0].referenced_table, "customers");
        assert_eq!(fks[0].on_delete, "RESTRICT");
        assert_eq!(fks[1].column_name, "product_id");
        assert_eq!(fks[1].referenced_table, "products");
        assert_eq!(fks[1].referenced_column, "id");
        assert_eq!(fks[1].on_delete, "CASCADE");
    }

    #[test]
    fn non_ascii_names_do_not_shift_offsets() {
        let ddl = "CREATE TABLE sipariş (ıd Integer, müşteri Integer, \
                   FOREIGN KEY (müşteri) REFERENCES müşteriler(ıd) ON DELETE SET NULL ON UPDATE RESTRICT)";
        let fks = parse_foreign_keys(ddl);
        assert_eq!(fks.len(), 1);
        assert_eq!(fks[0].column_name, "müşteri");
        assert_eq!(fks[0].referenced_table, "müşteriler");
        assert_eq!(fks[0].referenced_column, "ıd");
        assert_eq!(fks[0].on_delete, "SET NULL");
    }

    #[test]
    fn index_columns_follow_show_indexes() {
        assert_eq!(index_columns("plain"), ["plain"]);
        assert_eq!(index_columns("(exchange, symbol, funding_time)"), ["exchange", "symbol", "funding_time"]);
        // As the engine writes them, unquoted
        assert_eq!(index_columns("(my col, Order)"), ["my col", "Order"]);
        assert_eq!(index_columns("(a,b, plain)"), ["a,b", "plain"]);
    }

    #[test]
    fn the_engine_lists_index_columns_this_way() {
        let db = stoolap::api::Database::open_in_memory().unwrap();
        db.execute(r#"CREATE TABLE t (id INTEGER PRIMARY KEY, "my col" TEXT, "a,b" TEXT, plain TEXT)"#, ()).unwrap();
        db.execute(r#"CREATE INDEX i1 ON t ("my col", "a,b", plain)"#, ()).unwrap();
        let rows = crate::db::DbManager::query_on(&db, "SHOW INDEXES FROM t", None).unwrap().rows;
        let listed = rows.iter().find(|r| r[1] == "i1").unwrap()[2].as_str().unwrap().to_string();
        assert_eq!(index_columns(&listed), ["my col", "a,b", "plain"], "{listed}");
    }
}
