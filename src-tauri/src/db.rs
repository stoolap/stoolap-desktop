use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use stoolap::api::Database;
use stoolap::core::Value;
use crate::i18n::t;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionMeta {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub conn_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub time: f64,
}

/// A query's result for the renderer: like QueryResult, without a
/// serde_json::Value per cell.
#[derive(Serialize)]
pub struct QueryRows {
    pub columns: Vec<String>,
    pub rows: ResultRows,
    pub time: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecResult {
    pub changes: i64,
    pub time: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub field: String,
    #[serde(rename = "type")]
    pub col_type: String,
    pub nullable: bool,
    pub key: String,
    #[serde(rename = "defaultValue")]
    pub default_value: String,
    pub extra: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexInfo {
    #[serde(rename = "tableName")]
    pub table_name: String,
    #[serde(rename = "indexName")]
    pub index_name: String,
    #[serde(rename = "columnName")]
    pub column_name: String,
    #[serde(rename = "indexType")]
    pub index_type: String,
    #[serde(rename = "isUnique")]
    pub is_unique: bool,
    #[serde(default)]
    pub options: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    #[serde(rename = "columnName")]
    pub column_name: String,
    #[serde(rename = "referencedTable")]
    pub referenced_table: String,
    #[serde(rename = "referencedColumn")]
    pub referenced_column: String,
    #[serde(rename = "onDelete")]
    pub on_delete: String,
    #[serde(rename = "onUpdate")]
    pub on_update: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FilterCondition {
    pub column: String,
    pub operator: String,
    pub value: String,
}

struct Connection {
    // Wrapped in Arc so we can share the SAME `Database` instance (and thus the
    // same executor / transaction state) across commands. `Database::clone`
    // would otherwise spin up a fresh executor with independent txn state.
    db: Arc<Database>,
    meta: ConnectionMeta,
    /// The user ran BEGIN on this handle and has not committed or rolled
    /// back yet. The engine can't be asked (a second BEGIN or a stray
    /// ROLLBACK succeeds silently), so it is tracked here.
    in_transaction: Arc<AtomicBool>,
}

/// Statements running longer than this are cancelled by the engine. The UI
/// can change it; 0 turns it off.
pub const DEFAULT_QUERY_TIMEOUT_MS: u64 = 5 * 60 * 1000;

pub struct DbManager {
    connections: Mutex<HashMap<String, Connection>>,
    query_timeout_ms: AtomicU64,
}

impl DbManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            query_timeout_ms: AtomicU64::new(DEFAULT_QUERY_TIMEOUT_MS),
        }
    }

    fn apply_timeout(&self, db: &Database) -> Result<(), String> {
        let ms = self.query_timeout_ms.load(Ordering::Relaxed);
        db.execute(&format!("PRAGMA query_timeout = {ms}"), ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// A clone of `db`: a separate session with its own transaction state.
    /// A clone does not inherit the handle's query timeout, so it is set here.
    pub fn session(&self, db: &Database) -> Result<Database, String> {
        let session = db.clone();
        self.apply_timeout(&session)?;
        Ok(session)
    }

    /// The query timeout in ms; 0 when off
    pub fn query_timeout_ms(&self) -> u64 {
        self.query_timeout_ms.load(Ordering::Relaxed)
    }

    /// Change the query timeout for every open connection and the ones
    /// opened later.
    pub fn set_query_timeout(&self, ms: u64) -> Result<(), String> {
        self.query_timeout_ms.store(ms, Ordering::Relaxed);
        let dbs: Vec<Arc<Database>> = self
            .lock_conns()?
            .values()
            .map(|c| Arc::clone(&c.db))
            .collect();
        for db in dbs {
            self.apply_timeout(&db)?;
        }
        Ok(())
    }

    fn lock_conns(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Connection>>, String> {
        self.connections
            .lock()
            .map_err(|_| "Connection pool is in an unrecoverable state".to_string())
    }

    /// Look up a connection and return a shared reference to its `Database`.
    /// We return `Arc<Database>` — NOT `Database::clone()` — because stoolap's
    /// `Clone` impl spawns a fresh executor with independent transaction state.
    /// Sharing the Arc keeps every caller operating on the same executor, so
    /// transactions persist across separate commands (e.g. typing `BEGIN;` in
    /// the editor and running it, then running an `INSERT;` afterwards).
    pub fn get_db(&self, conn_id: &str) -> Result<Arc<Database>, String> {
        let conns = self.lock_conns()?;
        let conn = conns.get(conn_id).ok_or_else(|| t("errors.connectionNotFound", &[]))?;
        Ok(Arc::clone(&conn.db))
    }

    /// Whether the user has a transaction open on the connection's handle.
    pub fn transaction_state(&self, conn_id: &str) -> Result<Arc<AtomicBool>, String> {
        let conns = self.lock_conns()?;
        let conn = conns.get(conn_id).ok_or_else(|| t("errors.connectionNotFound", &[]))?;
        Ok(Arc::clone(&conn.in_transaction))
    }

    /// Run a query against an already-cloned Database handle.
    /// Use this for multi-step operations that must share a transaction.
    pub fn query_on(
        db: &Database,
        sql: &str,
        params: Option<Vec<serde_json::Value>>,
    ) -> Result<QueryResult, String> {
        let start = Instant::now();
        let QueryRows { columns, rows, .. } = Self::query_rows_on(db, sql, params)?;
        let rows = rows
            .0
            .iter()
            .map(|row| (0..row.len()).map(|i| value_to_json(row.get(i))).collect())
            .collect();
        let time = start.elapsed().as_secs_f64() * 1000.0;
        let time = (time * 100.0).round() / 100.0;
        Ok(QueryResult { columns, rows, time })
    }

    /// Run a query, keeping the rows as the engine's values: they serialize
    /// straight to JSON for the renderer, without a serde_json::Value per cell.
    pub fn query_rows_on(
        db: &Database,
        sql: &str,
        params: Option<Vec<serde_json::Value>>,
    ) -> Result<QueryRows, String> {
        let start = Instant::now();
        let rows = match params {
            Some(p) => db.query(sql, json_to_params(&p)),
            None => db.query(sql, ()),
        }
        .map_err(|e| e.to_string())?;
        let columns: Vec<String> = rows.columns().iter().map(|c| c.to_string()).collect();
        let rows = rows
            .map(|row| row.map(|r| r.into_inner()).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let time = start.elapsed().as_secs_f64() * 1000.0;
        let time = (time * 100.0).round() / 100.0;
        Ok(QueryRows { columns, rows: ResultRows(rows), time })
    }

    /// Run an execute against an already-cloned Database handle.
    /// Use this for multi-step operations that must share a transaction.
    pub fn execute_on(
        db: &Database,
        sql: &str,
        params: Option<Vec<serde_json::Value>>,
    ) -> Result<ExecResult, String> {
        let start = Instant::now();
        let changes = if let Some(p) = params {
            let param_vec = json_to_params(&p);
            db.execute(sql, param_vec).map_err(|e| e.to_string())?
        } else {
            db.execute(sql, ()).map_err(|e| e.to_string())?
        };
        let time = start.elapsed().as_secs_f64() * 1000.0;
        let time = (time * 100.0).round() / 100.0;
        Ok(ExecResult { changes, time })
    }

    pub fn open(&self, path: &str, name: Option<&str>) -> Result<ConnectionMeta, String> {
        let is_memory = path == ":memory:";
        let db = if is_memory {
            Database::open_in_memory().map_err(|e| e.to_string())?
        } else {
            // Stoolap expects DSN format: file:///path/to/db
            let dsn = if path.starts_with("file://") {
                path.to_string()
            } else {
                format!("file://{}", path)
            };
            Database::open(&dsn).map_err(|e| e.to_string())?
        };
        self.apply_timeout(&db)?;

        let id = uuid::Uuid::new_v4().to_string();
        let display_name = name.unwrap_or(if is_memory {
            "In-Memory"
        } else {
            path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(path)
        });

        let meta = ConnectionMeta {
            id: id.clone(),
            name: display_name.to_string(),
            path: path.to_string(),
            conn_type: if is_memory {
                "memory".to_string()
            } else {
                "file".to_string()
            },
        };

        let mut conns = self.lock_conns()?;
        conns.insert(
            id,
            Connection {
                db: Arc::new(db),
                meta: meta.clone(),
                in_transaction: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(meta)
    }

    pub fn close(&self, conn_id: &str) -> Result<(), String> {
        let removed = {
            let mut conns = self.lock_conns()?;
            conns.remove(conn_id)
        };
        if let Some(conn) = removed {
            // Only close if we hold the last reference; an in-flight command
            // holding an Arc clone will close the DB when it drops.
            if let Ok(db) = Arc::try_unwrap(conn.db) {
                db.close().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn close_example(&self) -> Result<(), String> {
        let removed = {
            let mut conns = self.lock_conns()?;
            let example_ids: Vec<String> = conns
                .iter()
                .filter(|(_, c)| c.meta.name == "Example DB")
                .map(|(id, _)| id.clone())
                .collect();
            example_ids
                .into_iter()
                .filter_map(|id| conns.remove(&id))
                .collect::<Vec<_>>()
        };
        for conn in removed {
            if let Ok(db) = Arc::try_unwrap(conn.db) {
                db.close().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ConnectionMeta>, String> {
        let conns = self.lock_conns()?;
        Ok(conns.values().map(|c| c.meta.clone()).collect())
    }

    pub fn query(
        &self,
        conn_id: &str,
        sql: &str,
        params: Option<Vec<serde_json::Value>>,
    ) -> Result<QueryResult, String> {
        let db = self.get_db(conn_id)?;
        Self::query_on(&db, sql, params)
    }

    pub fn execute(
        &self,
        conn_id: &str,
        sql: &str,
        params: Option<Vec<serde_json::Value>>,
    ) -> Result<ExecResult, String> {
        let db = self.get_db(conn_id)?;
        Self::execute_on(&db, sql, params)
    }

    pub fn close_all(&self) -> Result<(), String> {
        let drained: Vec<Connection> = {
            let mut conns = self.lock_conns()?;
            conns.drain().map(|(_, c)| c).collect()
        };
        for conn in drained {
            if let Ok(db) = Arc::try_unwrap(conn.db) {
                db.close().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

fn json_to_params(values: &[serde_json::Value]) -> stoolap::api::ParamVec {
    let mut params = stoolap::api::ParamVec::new();
    for v in values {
        match v {
            serde_json::Value::Null => params.push(Value::Null(stoolap::core::DataType::Null)),
            serde_json::Value::Bool(b) => params.push(Value::Boolean(*b)),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    params.push(Value::Integer(i));
                } else if let Some(f) = n.as_f64() {
                    params.push(Value::Float(f));
                }
            }
            serde_json::Value::String(s) => params.push(Value::from(s.as_str())),
            _ => params.push(Value::from(v.to_string().as_str())),
        }
    }
    params
}

/// Number.MAX_SAFE_INTEGER
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn value_to_json(val: Option<&Value>) -> serde_json::Value {
    serde_json::to_value(Cell(val)).unwrap_or(serde_json::Value::Null)
}

/// A cell as the renderer reads it.
pub struct Cell<'a>(pub Option<&'a Value>);

impl Serialize for Cell<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            None | Some(Value::Null(_)) => s.serialize_unit(),
            // JavaScript numbers hold integers exactly only up to 2^53; beyond
            // that the grid would show, edit and delete a rounded key, so those
            // travel as text (the engine reads text back into INTEGER columns)
            Some(Value::Integer(i)) if i.unsigned_abs() > MAX_SAFE_INTEGER => s.collect_str(i),
            Some(Value::Integer(i)) => s.serialize_i64(*i),
            // serde_json writes NaN and infinities as null
            Some(Value::Float(f)) => s.serialize_f64(*f),
            Some(Value::Boolean(b)) => s.serialize_bool(*b),
            Some(Value::Text(t)) => s.serialize_str(t.as_str()),
            Some(Value::Timestamp(ts)) => s.serialize_str(&ts.to_rfc3339()),
            Some(v @ Value::Extension(_)) => match v.as_json() {
                // A JSON value goes as itself; unparsable JSON text as text
                Some(json) => match serde_json::from_str::<serde_json::Value>(json) {
                    Ok(parsed) => parsed.serialize(s),
                    Err(_) => s.serialize_str(json),
                },
                // A vector or another extension as its display text
                None => s.collect_str(v),
            },
        }
    }
}

/// A query's rows, in the engine's own values.
pub struct ResultRows(pub Vec<stoolap::core::Row>);

impl Serialize for ResultRows {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        struct Cells<'a>(&'a stoolap::core::Row);
        impl Serialize for Cells<'_> {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_seq((0..self.0.len()).map(|i| Cell(self.0.get(i))))
            }
        }
        let mut seq = s.serialize_seq(Some(self.0.len()))?;
        for row in &self.0 {
            seq.serialize_element(&Cells(row))?;
        }
        seq.end()
    }
}

/// `s` as a SQL string literal the engine reads back exactly. It reads
/// backslash escapes inside quotes (\n is a newline), so \ is doubled too.
pub fn sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

/// `val` as a SQL literal that restores it exactly: integers in full (no
/// JavaScript rounding), JSON as its own text (so `null` and strings in a
/// JSON column stay JSON, apart from SQL NULL and TEXT).
pub fn sql_literal(val: Option<&Value>) -> String {
    let quote = sql_string;
    match val {
        None | Some(Value::Null(_)) => "NULL".into(),
        Some(Value::Integer(i)) => i.to_string(),
        // Debug keeps the shortest form that reads back the same (1e300, 0.1)
        Some(Value::Float(f)) if f.is_finite() => format!("{f:?}"),
        Some(Value::Float(_)) => "NULL".into(),
        Some(Value::Boolean(b)) => (if *b { "TRUE" } else { "FALSE" }).into(),
        Some(Value::Text(s)) => quote(s),
        Some(Value::Timestamp(ts)) => quote(&ts.to_rfc3339()),
        Some(v @ Value::Extension(_)) => match v.as_json() {
            Some(json) => quote(json),
            None => quote(&v.to_string()),
        },
    }
}

/// INSERT statements for one page of `table`'s rows, for a SQL backup,
/// and how many rows they hold.
pub fn table_inserts(db: &Database, table: &str, offset: i64, limit: i64) -> Result<(String, usize), String> {
    let quote_id = |id: &str| format!("\"{}\"", id.replace('"', "\"\""));
    let table = quote_id(table);
    let sql = format!("SELECT * FROM {table} LIMIT {} OFFSET {}", limit.max(0), offset.max(0));
    let rows = db.query(&sql, ()).map_err(|e| e.to_string())?;
    let columns: Vec<String> = rows.columns().iter().map(|c| quote_id(c)).collect();
    let head = format!("INSERT INTO {table} ({}) VALUES (", columns.join(", "));
    let mut out = String::new();
    let mut count = 0;
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        let values: Vec<String> = (0..columns.len()).map(|i| sql_literal(row.get_value(i))).collect();
        out.push_str(&head);
        out.push_str(&values.join(", "));
        out.push_str(");\n");
        count += 1;
    }
    Ok((out, count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clone_has_its_own_transaction() {
        let db = Database::open_in_memory().unwrap();
        DbManager::execute_on(&db, "CREATE TABLE t (id INTEGER PRIMARY KEY)", None).unwrap();

        let session = db.clone();
        DbManager::execute_on(&session, "BEGIN", None).unwrap();
        DbManager::execute_on(&session, "INSERT INTO t VALUES (1)", None).unwrap();
        // A write on the shared handle while the clone's transaction is open
        DbManager::execute_on(&db, "INSERT INTO t VALUES (2)", None).unwrap();
        DbManager::execute_on(&session, "ROLLBACK", None).unwrap();

        let rows = DbManager::query_on(&db, "SELECT id FROM t ORDER BY id", None).unwrap();
        assert_eq!(rows.rows, vec![vec![serde_json::json!(2)]]);
    }

    #[test]
    fn query_timeout_cancels_on_handles_and_sessions() {
        let manager = DbManager::new();
        let meta = manager.open(":memory:", None).unwrap();
        let db = manager.get_db(&meta.id).unwrap();
        DbManager::execute_on(&db, "CREATE TABLE t (id INTEGER PRIMARY KEY)", None).unwrap();
        for i in 0..100 {
            DbManager::execute_on(&db, &format!("INSERT INTO t VALUES ({i})"), None).unwrap();
        }
        // 10^10 rows: never finishes within the limit
        let slow = "SELECT COUNT(*) FROM t a, t b, t c, t d, t e";

        manager.set_query_timeout(50).unwrap();
        let started = Instant::now();
        assert!(DbManager::query_on(&db, slow, None).is_err());
        let session = manager.session(&db).unwrap();
        assert!(DbManager::query_on(&session, slow, None).is_err());
        assert!(started.elapsed().as_secs() < 10);

        // Turned off, quick statements still run
        manager.set_query_timeout(0).unwrap();
        let rows = DbManager::query_on(&db, "SELECT COUNT(*) FROM t", None).unwrap();
        assert_eq!(rows.rows, vec![vec![serde_json::json!(100)]]);
    }

    #[test]
    fn backup_inserts_restore_every_value_exactly() {
        let src = Database::open_in_memory().unwrap();
        let schema = "CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER, f FLOAT, s TEXT, b BOOLEAN, \
                      ts TIMESTAMP, j JSON, v VECTOR(3))";
        DbManager::execute_on(&src, schema, None).unwrap();
        DbManager::execute_on(
            &src,
            "INSERT INTO t VALUES \
             (1, 9007199254740993, 0.1, 'it''s', TRUE, '2026-01-02T03:04:05Z', '{\"a\":1}', '[1, 2.5, -3]'), \
             (2, -9223372036854775808, 1e300, '{\"a\":1}', FALSE, NULL, '[1,2]', NULL), \
             (3, NULL, NULL, NULL, NULL, NULL, 'null', NULL), \
             (4, 0, -2.5, '', NULL, NULL, '\"text\"', NULL)",
            None,
        )
        .unwrap();
        // Backslashes, bound as parameters so they are stored as typed
        DbManager::execute_on(
            &src,
            "INSERT INTO t (id, s, j) VALUES (5, ?, ?)",
            Some(vec![json!("C:\\ and a\\nb and it's"), json!(r#"{"text":"a\nb","path":"C:\\"}"#)]),
        )
        .unwrap();
        let (sql, count) = table_inserts(&src, "t", 0, 100).unwrap();
        assert_eq!(count, 5);

        let dst = Database::open_in_memory().unwrap();
        DbManager::execute_on(&dst, schema, None).unwrap();
        for stmt in sql.lines() {
            DbManager::execute_on(&dst, stmt, None).unwrap_or_else(|e| panic!("{stmt}: {e}"));
        }
        let read = |db: &Database| {
            let rows = db.query("SELECT * FROM t ORDER BY id", ()).unwrap();
            let n = rows.columns().len();
            rows.map(|r| {
                let r = r.unwrap();
                (0..n).map(|i| sql_literal(r.get_value(i))).collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
        };
        assert_eq!(read(&dst), read(&src));
        // SQL NULL and JSON null stay apart, as do TEXT and JSON
        assert!(sql.contains("9007199254740993"), "{sql}");
        assert!(sql.lines().nth(2).unwrap().ends_with("NULL, 'null', NULL);"), "{sql}");
    }

    #[test]
    fn integers_beyond_javascripts_range_round_trip_as_text() {
        let db = Database::open_in_memory().unwrap();
        DbManager::execute_on(&db, "CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)", None).unwrap();
        DbManager::execute_on(&db, "INSERT INTO t VALUES (9007199254740993, 1), (9007199254740992, 2), (5, 3)", None)
            .unwrap();
        let rows = DbManager::query_on(&db, "SELECT id FROM t ORDER BY id", None).unwrap().rows;
        assert_eq!(
            rows,
            vec![vec![json!(5)], vec![json!("9007199254740992")], vec![json!("9007199254740993")]]
        );
        // The grid sends the key back as it got it, and hits only that row
        let changed =
            DbManager::execute_on(&db, "DELETE FROM t WHERE id = ?", Some(vec![json!("9007199254740993")])).unwrap();
        assert_eq!(changed.changes, 1);
        let left = DbManager::query_on(&db, "SELECT n FROM t ORDER BY id", None).unwrap().rows;
        assert_eq!(left, vec![vec![json!(3)], vec![json!(2)]]);
    }

    #[test]
    fn string_literals_read_back_exactly() {
        let db = Database::open_in_memory().unwrap();
        for s in [r"C:\new\file.csv", "it's", r"a\'b", r"\\server\share", "line\nbreak"] {
            let rows = DbManager::query_on(&db, &format!("SELECT {}", sql_string(s)), None).unwrap().rows;
            assert_eq!(rows, vec![vec![json!(s)]], "{s}");
        }
    }

    #[test]
    fn rows_serialize_as_the_renderer_reads_them() {
        let db = Database::open_in_memory().unwrap();
        db.execute(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER, f FLOAT, b BOOLEAN, s TEXT, ts TIMESTAMP, j JSON, v VECTOR(2), n TEXT)",
            (),
        )
        .unwrap();
        db.execute(
            r#"INSERT INTO t VALUES (1, 9007199254740993, 1.5, true, 'a"\b', '2026-01-02 03:04:05', '{"k": [1, null]}', '[0.5, 1]', NULL)"#,
            (),
        )
        .unwrap();
        let sql = "SELECT * FROM t";
        let fast = serde_json::to_value(DbManager::query_rows_on(&db, sql, None).unwrap().rows).unwrap();
        let expected = serde_json::json!([[
            1,
            "9007199254740993",
            1.5,
            true,
            "a\"\\b",
            "2026-01-02T03:04:05+00:00",
            {"k": [1, null]},
            "[0.5, 1.0]",
            null
        ]]);
        assert_eq!(fast, expected);
        // The other commands' path gives the same cells
        assert_eq!(serde_json::json!(DbManager::query_on(&db, sql, None).unwrap().rows), expected);
    }
}
