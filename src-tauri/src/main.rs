#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The objc crate's msg_send! macro expands to code gated on `cfg(cargo-clippy)`,
// which newer rustc flags as an unknown cfg. Suppress crate-wide since the
// #[allow] attribute doesn't cross macro-expansion boundaries.
#![allow(unexpected_cfgs)]

mod commands;
mod db;
mod sql_utils;

use db::DbManager;
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(DbManager::new())
        .invoke_handler(tauri::generate_handler![
            // Connection
            commands::connection::db_open,
            commands::connection::db_close,
            commands::connection::db_list,
            commands::connection::db_close_example,
            // Query
            commands::query::db_query,
            commands::query::db_execute,
            commands::query::db_execute_query,
            // Schema
            commands::schema::db_tables,
            commands::schema::db_views,
            commands::schema::db_describe,
            commands::schema::db_indexes,
            commands::schema::db_fks,
            commands::schema::db_ddl,
            // Data
            commands::data::db_table_rows,
            commands::data::db_table_count,
            commands::data::db_insert_row,
            commands::data::db_insert_rows,
            commands::data::db_update_row,
            commands::data::db_delete_row,
            commands::data::db_import_file,
            // System
            commands::system::get_accent_color,
            commands::system::get_version,
        ])
        .setup(|app| {
            // Build application menu
            build_menu(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<DbManager>();
                let _ = state.close_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::*;

    let app_handle = app.handle();

    let open_db = MenuItemBuilder::with_id("open-db", "Open Database...")
        .accelerator("CmdOrCtrl+O")
        .build(app_handle)?;
    let new_memory = MenuItemBuilder::with_id("new-memory", "New In-Memory Database")
        .accelerator("CmdOrCtrl+N")
        .build(app_handle)?;
    let load_example =
        MenuItemBuilder::with_id("load-example", "Load Example Database").build(app_handle)?;
    let backup = MenuItemBuilder::with_id("backup", "Backup Database...")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app_handle)?;
    let restore =
        MenuItemBuilder::with_id("restore", "Restore from Backup...").build(app_handle)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app_handle)?;

    let file_menu = SubmenuBuilder::new(app_handle, "File")
        .item(&open_db)
        .item(&new_memory)
        .item(&load_example)
        .separator()
        .item(&backup)
        .item(&restore)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app_handle, "View")
        .item(&toggle_sidebar)
        .separator()
        .build()?;

    let window_menu = SubmenuBuilder::new(app_handle, "Window")
        .minimize()
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let about = MenuItemBuilder::with_id("about", "About Stoolap Desktop").build(app_handle)?;
        let check_updates =
            MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app_handle)?;

        let app_menu = SubmenuBuilder::new(app_handle, "Stoolap Desktop")
            .item(&about)
            .item(&check_updates)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let menu = MenuBuilder::new(app_handle)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?;
        app.set_menu(menu)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let menu = MenuBuilder::new(app_handle)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?;
        app.set_menu(menu)?;
    }

    // Handle menu events
    app.on_menu_event(move |app_handle, event| {
        if let Some(window) = app_handle.get_webview_window("main") {
            match event.id().as_ref() {
                "open-db" => {
                    let _ = window.emit("menu:open-database", ());
                }
                "new-memory" => {
                    let _ = window.emit("menu:new-memory-db", ());
                }
                "load-example" => {
                    let _ = window.emit("menu:load-example", ());
                }
                "backup" => {
                    let _ = window.emit("menu:backup", ());
                }
                "restore" => {
                    let _ = window.emit("menu:restore", ());
                }
                "toggle-sidebar" => {
                    let _ = window.emit("menu:toggle-sidebar", ());
                }
                "about" => {
                    let _ = window.emit("menu:about", ());
                }
                "check-updates" => {
                    let _ = window.emit("menu:check-updates", ());
                }
                _ => {}
            }
        }
    });

    Ok(())
}
