use tauri::AppHandle;

#[tauri::command]
pub fn get_accent_color() -> String {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSColor, NSColorSpace};
        // In the colour space the components were read in before
        let rgb = NSColor::controlAccentColor().colorUsingColorSpace(&NSColorSpace::genericRGBColorSpace());
        let Some(rgb) = rgb else { return "007affff".to_string() };
        let byte = |c: f64| (c * 255.0).clamp(0.0, 255.0) as u8;
        format!(
            "{:02x}{:02x}{:02x}ff",
            byte(rgb.redComponent()),
            byte(rgb.greenComponent()),
            byte(rgb.blueComponent()),
        )
    }
    // The accent Windows draws title bars and its own controls in
    #[cfg(windows)]
    {
        windows_accent().unwrap_or_else(|| "007affff".to_string())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        "007affff".to_string()
    }
}

/// HKCU\Software\Microsoft\Windows\DWM\AccentColor, kept as 0xAABBGGRR,
/// as "rrggbbff"
#[cfg(windows)]
fn windows_accent() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(r"Software\Microsoft\Windows\DWM"), wide("AccentColor"));
    let mut abgr: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: the value is a DWORD and the buffer holds one
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut abgr as *mut u32).cast(),
            &mut size,
        )
    };
    (read == 0).then(|| {
        let [r, g, b, _] = abgr.to_le_bytes();
        format!("{r:02x}{g:02x}{b:02x}ff")
    })
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
