#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The objc crate's msg_send! macro expands to code gated on `cfg(cargo-clippy)`,
// which newer rustc flags as an unknown cfg. Suppress crate-wide since the
// #[allow] attribute doesn't cross macro-expansion boundaries.
#![allow(unexpected_cfgs)]

mod agent;
mod commands;
mod db;
mod i18n;
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
        .manage(agent::AgentState::default())
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
            commands::query::db_transaction_open,
            // Schema
            commands::schema::db_tables,
            commands::schema::db_views,
            commands::schema::db_describe,
            commands::schema::db_indexes,
            commands::schema::db_fks,
            commands::schema::db_ddl,
            // Data
            commands::data::db_table_rows,
            commands::data::db_table_inserts,
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
            i18n::get_language,
            i18n::set_language,
            // Agent
            agent::agent_models,
            agent::agent_backends,
            agent::agent_console_install,
            agent::agent_console_login,
            agent::agent_console_logout,
            agent::agent_codex_login,
            agent::agent_codex_logout,
            agent::agent_open_link,
            agent::agent_set_key,
            agent::agent_delete_key,
            agent::agent_send,
            agent::agent_cancel,
            agent::agent_reset,
            agent::agent_write_result,
        ])
        .setup(|app| {
            app.manage(RecentMenu(std::sync::Mutex::new(None)));
            i18n::init(app.handle());
            build_menu(app.handle())?;
            app.on_menu_event(on_menu_event);
            if let Some(window) = app.get_webview_window("main") {
                match_background_to_theme(&window, window.theme().ok());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Settings and About are windows too: only the main one's
            // closing ends the session
            tauri::WindowEvent::Destroyed if window.label() == "main" => {
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
        Some(tauri::Theme::Dark) => tauri::window::Color(0x18, 0x18, 0x18, 0xff),
        _ => tauri::window::Color(0xff, 0xff, 0xff, 0xff),
    };
    let _ = window.set_background_color(Some(color));
}

/// The menu bar, in the app's language. Built again when the language changes.
fn build_menu(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::*;

    let lang = i18n::current(app_handle);
    let t = |key: &str| i18n::text(lang, key);

    let open_db = MenuItemBuilder::with_id("open-db", t("openDatabase"))
        .accelerator("CmdOrCtrl+O")
        .build(app_handle)?;
    let new_memory = MenuItemBuilder::with_id("new-memory", t("newMemory"))
        .accelerator("CmdOrCtrl+N")
        .build(app_handle)?;
    let load_example = MenuItemBuilder::with_id("load-example", t("loadExample")).build(app_handle)?;
    let backup = MenuItemBuilder::with_id("backup", t("backup"))
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app_handle)?;
    let restore = MenuItemBuilder::with_id("restore", t("restore")).build(app_handle)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", t("toggleSidebar"))
        .accelerator("CmdOrCtrl+B")
        .build(app_handle)?;
    let toggle_agent = MenuItemBuilder::with_id("toggle-agent", t("toggleAgent"))
        .accelerator("CmdOrCtrl+L")
        .build(app_handle)?;
    let settings = MenuItemBuilder::with_id("settings", t("settings"))
        .accelerator("CmdOrCtrl+,")
        .build(app_handle)?;
    let about = MenuItemBuilder::with_id("about", t("about")).build(app_handle)?;
    let check_updates = MenuItemBuilder::with_id("check-updates", t("checkUpdates")).build(app_handle)?;

    // Filled by the renderer through set_recent_databases; a rebuilt menu
    // gets the entries the last one had
    let open_recent = SubmenuBuilder::new(app_handle, t("openRecent")).build()?;
    {
        let state = app_handle.state::<RecentMenu>();
        let mut recent = state.0.lock().map_err(|e| e.to_string())?;
        let entries = recent.take().map(|(_, e)| e).unwrap_or_default();
        fill_recent_menu(app_handle, &open_recent, &entries)?;
        *recent = Some((open_recent.clone(), entries));
    }

    let file_menu = SubmenuBuilder::new(app_handle, t("file"))
        .item(&open_db)
        .item(&open_recent)
        .item(&new_memory)
        .item(&load_example)
        .separator()
        .item(&backup)
        .item(&restore);
    // macOS has Settings in the app menu
    #[cfg(not(target_os = "macos"))]
    let file_menu = file_menu.separator().item(&settings);
    let file_menu = file_menu.separator().close_window_with_text(t("closeWindow")).build()?;

    let edit_menu = SubmenuBuilder::new(app_handle, t("edit"))
        .undo_with_text(t("undo"))
        .redo_with_text(t("redo"))
        .separator()
        .cut_with_text(t("cut"))
        .copy_with_text(t("copy"))
        .paste_with_text(t("paste"))
        .select_all_with_text(t("selectAll"))
        .build()?;

    let view_menu = SubmenuBuilder::new(app_handle, t("view"))
        .item(&toggle_sidebar)
        .item(&toggle_agent)
        .build()?;

    let window_menu = SubmenuBuilder::new(app_handle, t("window"))
        .minimize_with_text(t("minimize"))
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app_handle, "Stoolap Desktop")
            .item(&about)
            .item(&check_updates)
            .separator()
            .item(&settings)
            .separator()
            .services_with_text(t("services"))
            .separator()
            .hide_with_text(t("hide"))
            .hide_others_with_text(t("hideOthers"))
            .show_all_with_text(t("showAll"))
            .separator()
            .quit_with_text(t("quit"))
            .build()?;
        MenuBuilder::new(app_handle)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = {
        // macOS has these in the app menu
        let help_menu = SubmenuBuilder::new(app_handle, t("help"))
            .item(&check_updates)
            .separator()
            .item(&about)
            .build()?;
        MenuBuilder::new(app_handle)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build()?
    };

    app_handle.set_menu(menu)?;
    Ok(())
}

fn on_menu_event(app_handle: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if id == "settings" || id == "about" {
        open_panel(app_handle, id);
        return;
    }
    let Some(window) = app_handle.get_webview_window("main") else { return };
    if let Some(path) = id.strip_prefix(RECENT_PREFIX) {
        let _ = window.emit("app:open-path", path);
        return;
    }
    let name = match id {
        "open-db" => "menu:open-database",
        "new-memory" => "menu:new-memory-db",
        "load-example" => "menu:load-example",
        "backup" => "menu:backup",
        "restore" => "menu:restore",
        "toggle-sidebar" => "menu:toggle-sidebar",
        "toggle-agent" => "menu:toggle-agent",
        "check-updates" => "menu:check-updates",
        _ => return,
    };
    let _ = window.emit(name, ());
}

/// Settings and About open as windows of their own, above the main one (a
/// second click brings the open one forward). The page sizes the window to
/// its content and shows it.
fn open_panel(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(main) = app.get_webview_window("main") else { return };
    let width = if label == "about" { 340.0 } else { 480.0 };
    let built = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(panel_title(app, label))
        .inner_size(width, 200.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .center()
        .parent(&main)
        .and_then(|builder| builder.build());
    match built {
        Ok(window) => {
            match_background_to_theme(&window, window.theme().ok());
            // On Windows and Linux the app's menu bar is every window's
            #[cfg(not(target_os = "macos"))]
            let _ = window.remove_menu();
        }
        Err(e) => eprintln!("Couldn't open the {label} window: {e}"),
    }
}

/// A panel window's title in the app's language. On macOS About has none,
/// as the system's own About windows don't.
fn panel_title(app: &tauri::AppHandle, label: &str) -> String {
    let lang = i18n::current(app);
    match label {
        "about" if cfg!(target_os = "macos") => String::new(),
        "about" => i18n::text(lang, "about"),
        // The menu item's "Settings…" without its ellipsis
        _ => i18n::text(lang, "settings").trim_end_matches(['…', '.']).to_string(),
    }
}

/// Retitle the open panel windows after a language change
fn retitle_panels(app: &tauri::AppHandle) {
    for label in ["settings", "about"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_title(&panel_title(app, label));
        }
    }
}

const RECENT_PREFIX: &str = "recent:";

/// The File → Open Recent submenu and its entries, kept so the renderer can
/// refill it and a rebuilt menu keeps them.
struct RecentMenu(std::sync::Mutex<Option<(tauri::menu::Submenu<tauri::Wry>, Vec<RecentDatabase>)>>);

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
        let none = MenuItemBuilder::new(i18n::text(i18n::current(app), "noRecent"))
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
    let mut recent = menu.0.lock().map_err(|e| e.to_string())?;
    if let Some((submenu, _)) = recent.as_ref() {
        fill_recent_menu(&app, submenu, &entries).map_err(|e| e.to_string())?;
    }
    if let Some((_, kept)) = recent.as_mut() {
        *kept = entries;
    }
    Ok(())
}
