#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
            commands::system::relaunch,
            commands::system::macos_version,
            set_recent_databases,
            i18n::get_language,
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
                // Made hidden (tauri.conf.json) and shown here, once the
                // window-state plugin has given it its saved size: shown at
                // once, it opened at the default size and then jumped
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // About is a window too (outside macOS): only the main one's
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
    // Not the predefined About item: macOS 26 gives that one an icon
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

    // The app's language, the chosen one ticked; "System" follows the computer
    let preference = i18n::preference(app_handle);
    let system = i18n::NAMES.iter().find(|(code, _)| *code == i18n::system_language()).map_or("English", |(_, name)| *name);
    let mut language_menu = SubmenuBuilder::new(app_handle, t("language"))
        .item(
            &CheckMenuItemBuilder::with_id(format!("{LANGUAGE_PREFIX}{}", i18n::SYSTEM), t("systemLanguage").replace("{{language}}", system))
                .checked(preference == i18n::SYSTEM)
                .build(app_handle)?,
        )
        .separator();
    for (code, name) in i18n::NAMES {
        language_menu = language_menu.item(
            &CheckMenuItemBuilder::with_id(format!("{LANGUAGE_PREFIX}{code}"), *name)
                .checked(preference == *code)
                .build(app_handle)?,
        );
    }
    let language_menu = language_menu.build()?;

    let file_menu = SubmenuBuilder::new(app_handle, t("file"))
        .item(&open_db)
        .item(&open_recent)
        .item(&new_memory)
        .item(&load_example)
        .separator()
        .item(&backup)
        .item(&restore);
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
        .item(&toggle_agent);
    // macOS has Language in the app menu, where Settings would be
    #[cfg(not(target_os = "macos"))]
    let view_menu = view_menu.separator().item(&language_menu);
    let view_menu = view_menu.build()?;

    let window_menu = SubmenuBuilder::new(app_handle, t("window"))
        .minimize_with_text(t("minimize"))
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app_handle, "Stoolap Desktop")
            .item(&about)
            .item(&check_updates)
            .separator()
            .item(&language_menu)
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
    if id == "about" {
        #[cfg(target_os = "macos")]
        show_about_panel(app_handle);
        #[cfg(not(target_os = "macos"))]
        open_panel(app_handle, id);
        return;
    }
    if let Some(code) = id.strip_prefix(LANGUAGE_PREFIX) {
        // After this event: switching rebuilds the menu that sent it
        let (app, code) = (app_handle.clone(), code.to_string());
        let _ = app_handle.run_on_main_thread(move || {
            if let Err(e) = i18n::set_language(app, code) {
                eprintln!("Couldn't switch the language: {e}");
            }
        });
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

/// About opens as a window of its own, above the main one (a second click
/// brings the open one forward). The page sizes the window to its content
/// and shows it.
#[cfg(not(target_os = "macos"))]
fn open_panel(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(main) = app.get_webview_window("main") else { return };
    let width = 340.0;
    let built = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(panel_title(app))
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

/// A panel window's title in the app's language
#[cfg(not(target_os = "macos"))]
fn panel_title(app: &tauri::AppHandle) -> String {
    i18n::text(i18n::current(app), "about")
}

/// Retitle the open About window after a language change
#[cfg(not(target_os = "macos"))]
fn retitle_panels(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("about") {
        let _ = window.set_title(&panel_title(app));
    }
}

const RECENT_PREFIX: &str = "recent:";
/// Language menu items: "language:system", "language:tr", …
const LANGUAGE_PREFIX: &str = "language:";

/// macOS' own About panel: the logo, name and version, then the tagline and
/// the engine, as the About window elsewhere. The logo is passed in because
/// a development build is no app bundle and would show a folder.
#[cfg(target_os = "macos")]
fn show_about_panel(app: &tauri::AppHandle) {
    use objc2::runtime::AnyObject;
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSColor, NSFont, NSImage, NSMutableParagraphStyle, NSTextAlignment};
    use objc2_foundation::{NSAttributedString, NSData, NSDictionary, NSString};

    // Menu events arrive on the main thread, where AppKit must be called
    let Some(mtm) = MainThreadMarker::new() else { return };
    let lang = i18n::current(app);
    let engine = engine_label(&commands::system::get_stoolap_version());
    let credits_text = format!(
        "{}\n{}",
        i18n::text(lang, "aboutTagline"),
        i18n::text(lang, "poweredBy").replace("{{engine}}", &engine)
    );
    // The year without a date library: a year is 365.2425 days on average
    let year = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(2025, |d| 1970 + d.as_secs() / 31_556_952);
    // The mark without its tile, which would vanish on the white panel
    let logo = include_bytes!("../icons/about.png");
    let text = NSString::from_str;

    // Small, grey and centred, as macOS' own apps' credits
    let style = NSMutableParagraphStyle::new();
    style.setAlignment(NSTextAlignment::Center);
    let (font, color) = (NSFont::systemFontOfSize(11.0), NSColor::secondaryLabelColor());
    let attributes = NSDictionary::<NSString, AnyObject>::from_slices(
        &[&*text("NSParagraphStyle"), &*text("NSFont"), &*text("NSColor")],
        &[style.as_ref(), font.as_ref(), color.as_ref()],
    );
    // SAFETY: each attribute is the kind of object its key takes
    let credits = unsafe {
        NSAttributedString::initWithString_attributes(NSAttributedString::alloc(), &text(&credits_text), Some(&attributes))
    };
    let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(logo));

    let (name, version, build) = (text("Stoolap Desktop"), text(&app.package_info().version.to_string()), text(""));
    let copyright = text(&format!("© 2025–{year} Stoolap · Apache License 2.0"));
    let mut keys = vec![
        text("ApplicationName"),
        text("ApplicationVersion"),
        text("Version"),
        text("Copyright"),
        text("Credits"),
    ];
    let mut values: Vec<&AnyObject> = vec![
        name.as_ref(),
        version.as_ref(),
        // Empty, or the bundle's build number follows in brackets
        build.as_ref(),
        copyright.as_ref(),
        credits.as_ref(),
    ];
    // Passed in: a development build is no app bundle and would show a folder
    if let Some(image) = &image {
        keys.push(text("ApplicationIcon"));
        values.push(image.as_ref());
    }
    let keys: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let options = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &values);
    // SAFETY: the options are the panel's documented keys with values of their kind
    unsafe { NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanelWithOptions(&options) };
}

/// "stoolap 0.5.0 (commit: <sha>, built: <time>)" as "Stoolap 0.5.0", with
/// the commit when it is a real hash (a crates.io build says "unknown")
#[cfg(target_os = "macos")]
fn engine_label(raw: &str) -> String {
    let mut parts = raw.split_whitespace();
    let (Some(_), Some(version)) = (parts.next(), parts.next()) else { return raw.to_string() };
    let commit = raw
        .split("commit:")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .map(str::trim)
        .filter(|c| c.len() >= 7 && c.chars().all(|ch| ch.is_ascii_hexdigit()));
    match commit {
        Some(c) => format!("Stoolap {version} · {}", &c[..7]),
        None => format!("Stoolap {version}"),
    }
}

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
