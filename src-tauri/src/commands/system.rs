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
