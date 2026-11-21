use tauri::AppHandle;

#[tauri::command]
#[allow(unexpected_cfgs)] // objc's msg_send! macro uses cfg(cargo-clippy)
pub fn get_accent_color() -> String {
    #[cfg(target_os = "macos")]
    #[allow(deprecated)] // cocoa deprecates in favor of objc2 — migration is out of scope
    {
        use cocoa::foundation::NSString as _;
        use objc::rc::autoreleasepool;
        use objc::*;
        autoreleasepool(|| unsafe {
            let color: *mut objc::runtime::Object = msg_send![class!(NSColor), controlAccentColor];
            if color.is_null() {
                return "007affff".to_string();
            }
            let space_name = cocoa::foundation::NSString::alloc(cocoa::base::nil)
                .init_str("NSCalibratedRGBColorSpace");
            let rgb: *mut objc::runtime::Object =
                msg_send![color, colorUsingColorSpaceName: space_name];
            // Release the alloc+init'd NSString; `colorUsingColorSpaceName:`
            // returns an autoreleased color, so the pool handles that side.
            let _: () = msg_send![space_name, release];
            if rgb.is_null() {
                return "007affff".to_string();
            }
            let r: f64 = msg_send![rgb, redComponent];
            let g: f64 = msg_send![rgb, greenComponent];
            let b: f64 = msg_send![rgb, blueComponent];
            format!(
                "{:02x}{:02x}{:02x}ff",
                (r * 255.0).clamp(0.0, 255.0) as u8,
                (g * 255.0).clamp(0.0, 255.0) as u8,
                (b * 255.0).clamp(0.0, 255.0) as u8,
            )
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        "007affff".to_string()
    }
}

#[tauri::command]
pub fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_stoolap_version() -> String {
    // Same string `SELECT VERSION()` returns:
    //   "stoolap {VERSION} (commit: {GIT_COMMIT}, built: {BUILD_TIME})"
    stoolap::common::version_info()
}

/// macOS's major version (0 elsewhere): the window's layout follows it
#[tauri::command]
pub fn macos_version() -> u32 {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output() {
        let version = String::from_utf8_lossy(&out.stdout);
        return version.trim().split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
    }
    0
}

/// Restart the app after an update. On macOS Tauri restarts with `open -n`,
/// which starts a second instance while this one still runs: the Dock shows it
/// as a new icon, apart from the one kept in the Dock. Instead, a shell waits
/// for this process to end and then opens the bundle as a normal launch.
#[tauri::command]
pub fn relaunch(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        // …/Stoolap.app/Contents/MacOS/<binary>
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.ancestors().nth(3).map(|p| p.to_path_buf()))
            .filter(|p| p.extension().is_some_and(|e| e == "app"));
        if let Some(bundle) = bundle {
            let script = format!(
                "while kill -0 {} 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open \"$0\"",
                std::process::id()
            );
            let spawned = Command::new("/bin/sh")
                .arg("-c")
                .arg(script)
                .arg(&bundle)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            if spawned.is_ok() {
                app.exit(0);
                return;
            }
        }
    }
    app.restart();
}
