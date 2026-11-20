//! The app's language: the one the user picked in Settings, or else the
//! system's. The renderer translates its own text; the native menu takes its
//! labels from each language's native.json, shared with the renderer.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Display;
use std::sync::{OnceLock, RwLock};
use tauri::{AppHandle, Emitter, Manager};

/// The `native` translations of each language. English is the fallback.
const NATIVE: &[(&str, &str)] = &[
    ("en", include_str!("../../src/renderer/src/locales/en/native.json")),
    ("tr", include_str!("../../src/renderer/src/locales/tr/native.json")),
    ("de", include_str!("../../src/renderer/src/locales/de/native.json")),
    ("fr", include_str!("../../src/renderer/src/locales/fr/native.json")),
    ("es", include_str!("../../src/renderer/src/locales/es/native.json")),
    ("pt-BR", include_str!("../../src/renderer/src/locales/pt-BR/native.json")),
    ("it", include_str!("../../src/renderer/src/locales/it/native.json")),
    ("nl", include_str!("../../src/renderer/src/locales/nl/native.json")),
    ("pl", include_str!("../../src/renderer/src/locales/pl/native.json")),
    ("ru", include_str!("../../src/renderer/src/locales/ru/native.json")),
    ("uk", include_str!("../../src/renderer/src/locales/uk/native.json")),
    ("ja", include_str!("../../src/renderer/src/locales/ja/native.json")),
    ("ko", include_str!("../../src/renderer/src/locales/ko/native.json")),
    ("zh-CN", include_str!("../../src/renderer/src/locales/zh-CN/native.json")),
    ("zh-TW", include_str!("../../src/renderer/src/locales/zh-TW/native.json")),
    ("id", include_str!("../../src/renderer/src/locales/id/native.json")),
];

const SYSTEM: &str = "system";

fn catalogs() -> &'static HashMap<&'static str, Value> {
    static CATALOGS: OnceLock<HashMap<&'static str, Value>> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        NATIVE
            .iter()
            .map(|(lang, json)| (*lang, serde_json::from_str(json).expect("a locale's native.json is valid JSON")))
            .collect()
    })
}

/// `key` ("menu" or "errors.emptyKey") in `lang`, or in English when that
/// language lacks it.
pub fn text(lang: &str, key: &str) -> String {
    [lang, "en"]
        .iter()
        .find_map(|l| key.split('.').try_fold(catalogs().get(l)?, |v, k| v.get(k))?.as_str())
        .unwrap_or(key)
        .to_string()
}

/// The language the app shows, for text written outside a command handler
static CURRENT: RwLock<&str> = RwLock::new("en");

fn lang() -> &'static str {
    CURRENT.read().map(|l| *l).unwrap_or("en")
}

/// Show `language` from now on (at launch, and when the user changes it).
fn set_current(language: &'static str) {
    if let Ok(mut current) = CURRENT.write() {
        *current = language;
    }
}

pub fn init(app: &AppHandle) {
    set_current(current(app));
}

/// `key` in the app's language, with each {{name}} filled in.
pub fn t(key: &str, vars: &[(&str, &dyn Display)]) -> String {
    vars.iter()
        .fold(text(lang(), key), |s, (name, value)| s.replace(&format!("{{{{{name}}}}}"), &value.to_string()))
}

/// `key` for a count: `key_one`, `key_few`, … as the language's plural rules
/// pick, with {{count}} and each {{name}} filled in.
pub fn t_count(key: &str, count: i64, vars: &[(&str, &dyn Display)]) -> String {
    let lang = lang();
    let form = format!("{key}_{}", plural_category(lang, count));
    let key = if text(lang, &form) != form { form } else { format!("{key}_other") };
    let mut all: Vec<(&str, &dyn Display)> = vec![("count", &count)];
    all.extend_from_slice(vars);
    t(&key, &all)
}

/// CLDR plural categories for whole numbers in the app's languages.
fn plural_category(lang: &str, n: i64) -> &'static str {
    let n = n.unsigned_abs();
    let (ten, hundred) = (n % 10, n % 100);
    match lang {
        "ja" | "ko" | "zh-CN" | "zh-TW" | "id" => "other",
        "fr" | "pt-BR" if n <= 1 => "one",
        "ru" | "uk" => match (ten, hundred) {
            (1, h) if h != 11 => "one",
            (2..=4, h) if !(12..=14).contains(&h) => "few",
            _ => "many",
        },
        "pl" => match (n, ten, hundred) {
            (1, _, _) => "one",
            (_, 2..=4, h) if !(12..=14).contains(&h) => "few",
            _ => "many",
        },
        _ if n == 1 => "one",
        // es, it, fr and pt-BR have "many" for 1,000,000 and up; "other" serves too
        _ => "other",
    }
}

/// The language the app has for a BCP 47 tag such as "pt-PT" or "zh-Hant-HK".
fn match_tag(tag: &str) -> Option<&'static str> {
    let tag = tag.replace('_', "-").to_lowercase();
    let primary = tag.split('-').next()?;
    if primary == "zh" {
        let traditional = ["hant", "tw", "hk", "mo"].iter().any(|t| tag.split('-').any(|p| p == *t));
        return Some(if traditional { "zh-TW" } else { "zh-CN" });
    }
    if primary == "pt" {
        return Some("pt-BR");
    }
    NATIVE.iter().map(|(l, _)| *l).find(|l| l.to_lowercase() == primary)
}

/// The first of the system's preferred languages the app has, else English.
fn system_language() -> &'static str {
    sys_locale::get_locales().find_map(|t| match_tag(&t)).unwrap_or("en")
}

fn resolve(preference: &str) -> &'static str {
    NATIVE
        .iter()
        .map(|(l, _)| *l)
        .find(|l| *l == preference)
        .unwrap_or_else(system_language)
}

fn settings_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("settings.json"))
}

/// "system" or a language code, as saved in Settings.
fn preference(app: &AppHandle) -> String {
    settings_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["language"].as_str().map(str::to_string))
        .unwrap_or_else(|| SYSTEM.to_string())
}

/// The language the app shows now.
pub fn current(app: &AppHandle) -> &'static str {
    resolve(&preference(app))
}

#[derive(Serialize)]
pub struct LanguageInfo {
    /// "system" or a language code
    preference: String,
    /// What the app shows
    language: &'static str,
    /// What "system" stands for
    system: &'static str,
}

fn info(app: &AppHandle) -> LanguageInfo {
    let preference = preference(app);
    LanguageInfo { language: resolve(&preference), system: system_language(), preference }
}

#[tauri::command]
pub fn get_language(app: AppHandle) -> LanguageInfo {
    info(&app)
}

/// Save the user's choice ("system" follows the system) and relabel the menu.
#[tauri::command]
pub fn set_language(app: AppHandle, preference: String) -> Result<LanguageInfo, String> {
    if preference != SYSTEM && !NATIVE.iter().any(|(l, _)| *l == preference) {
        return Err(format!("Unknown language {preference}"));
    }
    let file = settings_file(&app).ok_or("No settings folder")?;
    std::fs::create_dir_all(file.parent().ok_or("No settings folder")?).map_err(|e| e.to_string())?;
    let mut settings = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    settings["language"] = Value::String(preference);
    std::fs::write(&file, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    set_current(current(&app));
    crate::build_menu(&app).map_err(|e| e.to_string())?;
    crate::retitle_panels(&app);
    let info = info(&app);
    // Every window follows, not only the one that changed it
    let _ = app.emit("app:language", &info.language);
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_tags_find_the_closest_language() {
        assert_eq!(match_tag("tr-TR"), Some("tr"));
        assert_eq!(match_tag("de_AT"), Some("de"));
        assert_eq!(match_tag("pt-PT"), Some("pt-BR"));
        assert_eq!(match_tag("zh-Hans-CN"), Some("zh-CN"));
        assert_eq!(match_tag("zh-Hant-HK"), Some("zh-TW"));
        assert_eq!(match_tag("zh-TW"), Some("zh-TW"));
        assert_eq!(match_tag("en-GB"), Some("en"));
        assert_eq!(match_tag("ar-SA"), None);
    }

    /// "a.b" for every string, plural forms folded into their key
    fn keys(v: &Value, prefix: &str, out: &mut Vec<String>) {
        match v.as_object() {
            Some(map) => map.iter().for_each(|(k, v)| keys(v, &format!("{prefix}{k}."), out)),
            None => {
                let key = prefix.trim_end_matches('.');
                let base = ["_one", "_few", "_many", "_other"].iter().find_map(|s| key.strip_suffix(s));
                out.push(base.unwrap_or(key).to_string());
            }
        }
    }

    #[test]
    fn every_language_has_every_native_text() {
        let mut english = vec![];
        keys(&catalogs()["en"], "", &mut english);
        for (lang, catalog) in catalogs() {
            let mut have = vec![];
            keys(catalog, "", &mut have);
            for key in &english {
                assert!(have.contains(key), "{lang} lacks native.{key}");
            }
        }
        assert_eq!(text("tr", "quit"), "Stoolap Desktop'tan Çık");
        assert_eq!(text("tr", "missing"), "missing");
    }

    #[test]
    fn plurals_follow_each_language() {
        let forms = |lang, ns: &[i64]| ns.iter().map(|n| plural_category(lang, *n)).collect::<Vec<_>>();
        assert_eq!(forms("en", &[0, 1, 2]), ["other", "one", "other"]);
        assert_eq!(forms("fr", &[0, 1, 2]), ["one", "one", "other"]);
        assert_eq!(forms("ru", &[1, 2, 5, 11, 21, 22, 25]), ["one", "few", "many", "many", "one", "few", "many"]);
        assert_eq!(forms("pl", &[1, 2, 5, 12, 21, 22]), ["one", "few", "many", "many", "many", "few"]);
        assert_eq!(forms("ja", &[1, 2]), ["other", "other"]);
    }
}
