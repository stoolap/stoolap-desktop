use crate::db::{ConnectionMeta, DbManager};
use tauri::State;

#[tauri::command]
pub async fn db_open(
    state: State<'_, DbManager>,
    path: String,
    name: Option<String>,
) -> Result<ConnectionMeta, String> {
    state.open(&path, name.as_deref())
}

#[tauri::command]
pub async fn db_close(state: State<'_, DbManager>, conn_id: String) -> Result<(), String> {
    state.close(&conn_id)
}

#[tauri::command]
pub async fn db_list(state: State<'_, DbManager>) -> Result<Vec<ConnectionMeta>, String> {
    state.list()
}

#[tauri::command]
pub async fn db_close_example(state: State<'_, DbManager>) -> Result<(), String> {
    state.close_example()
}
