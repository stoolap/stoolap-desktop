use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use stoolap::api::Database;
use stoolap::core::Value;

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
        let conn = conns.get(conn_id).ok_or("Connection not found")?;
        Ok(Arc::clone(&conn.db))
    }

    /// Run a query against an already-cloned Database handle.
    /// Use this for multi-step operations that must share a transaction.
    pub fn query_on(
        db: &Database,
        sql: &str,
        params: Option<Vec<serde_json::Value>>,
    ) -> Result<QueryResult, String> {
        let start = Instant::now();
        let rows = if let Some(p) = params {
            let param_vec = json_to_params(&p);
            db.query(sql, param_vec).map_err(|e| e.to_string())?
        } else {
            db.query(sql, ()).map_err(|e| e.to_string())?
        };
        let columns: Vec<String> = rows.columns().iter().map(|c| c.to_string()).collect();
        let mut result_rows = Vec::new();
        for row in rows {
            let row = row.map_err(|e| e.to_string())?;
            let mut values = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                values.push(value_to_json(row.get_value(i)));
            }
            result_rows.push(values);
        }
        let time = start.elapsed().as_secs_f64() * 1000.0;
        let time = (time * 100.0).round() / 100.0;
        Ok(QueryResult {
            columns,
            rows: result_rows,
            time,
        })
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

fn value_to_json(val: Option<&Value>) -> serde_json::Value {
    match val {
        None | Some(Value::Null(_)) => serde_json::Value::Null,
        Some(Value::Integer(i)) => serde_json::json!(*i),
        Some(Value::Float(f)) => serde_json::json!(*f),
        Some(Value::Boolean(b)) => serde_json::json!(*b),
        Some(Value::Text(s)) => serde_json::json!(s.as_str()),
        Some(Value::Timestamp(ts)) => serde_json::json!(ts.to_rfc3339()),
        Some(v @ Value::Extension(_)) => {
            // JSON extension: use as_json()
            if let Some(json_str) = v.as_json() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
                    return parsed;
                }
                return serde_json::json!(json_str);
            }
            // Vector or other extension: format as display string
            serde_json::json!(format!("{}", v))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
