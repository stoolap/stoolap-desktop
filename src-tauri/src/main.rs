#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The objc crate's msg_send! macro expands to code gated on `cfg(cargo-clippy)`,
// which newer rustc flags as an unknown cfg. Suppress crate-wide since the
// #[allow] attribute doesn't cross macro-expansion boundaries.
#![allow(unexpected_cfgs)]

mod assistant;
mod commands;
mod db;
mod sql_utils;

use db::DbManager;
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        // Must be registered first. A second launch focuses this window, and
        // a database folder passed on its command line opens here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
                for arg in argv.iter().skip(1) {
                    if std::path::Path::new(arg).exists() {
                        let _ = window.emit("app:open-path", arg);
                    }
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(DbManager::new())
        .manage(assistant::AssistantState::default())
        .invoke_handler(tauri::generate_handler![
            // Connection
            commands::connection::db_open,
            commands::connection::db_close,
            commands::connection::db_list,
            commands::connection::db_close_example,
            commands::connection::db_set_query_timeout,
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
            commands::system::get_stoolap_version,
            set_recent_databases,
            // Assistant
            assistant::assistant_models,
            assistant::assistant_backends,
            assistant::assistant_console_install,
            assistant::assistant_console_login,
            assistant::assistant_console_logout,
            assistant::assistant_codex_login,
            assistant::assistant_codex_logout,
            assistant::assistant_open_link,
            assistant::assistant_set_key,
            assistant::assistant_delete_key,
            assistant::assistant_send,
            assistant::assistant_cancel,
            assistant::assistant_reset,
            assistant::assistant_write_result,
        ])
        .setup(|app| {
            // Build application menu
            build_menu(app)?;
            if let Some(window) = app.get_webview_window("main") {
                match_background_to_theme(&window, window.theme().ok());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let state = window.state::<DbManager>();
                let _ = state.close_all();
            }
            tauri::WindowEvent::ThemeChanged(theme) => {
                if let Some(webview) = window.get_webview_window(window.label()) {
                    match_background_to_theme(&webview, Some(*theme));
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Paint the window in the page's background colour (`--background` in
/// globals.css) so a dark-mode launch does not flash white before the
/// webview's first frame.
fn match_background_to_theme(window: &tauri::WebviewWindow, theme: Option<tauri::Theme>) {
    let color = match theme {
        Some(tauri::Theme::Dark) => tauri::window::Color(0x23, 0x23, 0x23, 0xff),
        _ => tauri::window::Color(0xff, 0xff, 0xff, 0xff),
    };
    let _ = window.set_background_color(Some(color));
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
    let toggle_assistant = MenuItemBuilder::with_id("toggle-assistant", "Toggle Assistant")
        .accelerator("CmdOrCtrl+L")
        .build(app_handle)?;

    // Filled by the renderer through set_recent_databases
    let open_recent = SubmenuBuilder::new(app_handle, "Open Recent").build()?;
    fill_recent_menu(app_handle, &open_recent, &[])?;
    app.manage(RecentMenu(open_recent.clone()));

    let file_menu = SubmenuBuilder::new(app_handle, "File")
        .item(&open_db)
        .item(&open_recent)
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
        .item(&toggle_assistant)
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
        // macOS has these in the app menu
        let about = MenuItemBuilder::with_id("about", "About Stoolap Desktop").build(app_handle)?;
        let check_updates =
            MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app_handle)?;
        let help_menu = SubmenuBuilder::new(app_handle, "Help")
            .item(&check_updates)
            .separator()
            .item(&about)
            .build()?;

        let menu = MenuBuilder::new(app_handle)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .item(&help_menu)
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
                "toggle-assistant" => {
                    let _ = window.emit("menu:toggle-assistant", ());
                }
                "about" => {
                    let _ = window.emit("menu:about", ());
                }
                "check-updates" => {
                    let _ = window.emit("menu:check-updates", ());
                }
                id => {
                    if let Some(path) = id.strip_prefix(RECENT_PREFIX) {
                        let _ = window.emit("app:open-path", path);
                    }
                }
            }
        }
    });

    Ok(())
}

const RECENT_PREFIX: &str = "recent:";

/// The File → Open Recent submenu, kept so the renderer can refill it.
struct RecentMenu(tauri::menu::Submenu<tauri::Wry>);

#[derive(serde::Deserialize)]
struct RecentDatabase {
    name: String,
    path: String,
}

fn fill_recent_menu(
    app: &tauri::AppHandle,
    menu: &tauri::menu::Submenu<tauri::Wry>,
    entries: &[RecentDatabase],
) -> tauri::Result<()> {
    use tauri::menu::MenuItemBuilder;

    for item in menu.items()? {
        menu.remove(&item)?;
    }
    if entries.is_empty() {
        let none = MenuItemBuilder::new("No Recent Databases")
            .enabled(false)
            .build(app)?;
        return menu.append(&none);
    }
    for entry in entries {
        // Two databases may share a name; tell them apart by their path.
        let same_name = entries.iter().filter(|e| e.name == entry.name).count() > 1;
        let label = if same_name {
            format!("{} — {}", entry.name, entry.path)
        } else {
            entry.name.clone()
        };
        let item = MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{}", entry.path), label)
            .build(app)?;
        menu.append(&item)?;
    }
    Ok(())
}

/// Replace File → Open Recent with the renderer's recent databases.
#[tauri::command]
fn set_recent_databases(
    app: tauri::AppHandle,
    menu: tauri::State<'_, RecentMenu>,
    entries: Vec<RecentDatabase>,
) -> Result<(), String> {
    fill_recent_menu(&app, &menu.0, &entries).map_err(|e| e.to_string())
}
