import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

/** The app's languages, each named in itself. Codes match src-tauri/src/i18n.rs */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "tr", name: "Türkçe" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "it", name: "Italiano" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "ru", name: "Русский" },
  { code: "uk", name: "Українська" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "id", name: "Bahasa Indonesia" },
] as const;

/** locales/<language>/<namespace>.json, bundled */
const files = import.meta.glob<Record<string, unknown>>("../locales/*/*.json", { eager: true, import: "default" });

export const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, data] of Object.entries(files)) {
  const [, lang, ns] = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
  (resources[lang] ??= {})[ns] = data;
}

/** The user's choice ("system" or a code), what the app shows, and what "system" is */
export interface LanguageInfo {
  preference: string;
  language: string;
  system: string;
}

function show(language: string) {
  document.documentElement.lang = language;
  return i18n.changeLanguage(language);
}

/** Start in the saved language, or the system's; English when that can't be read. */
export async function initI18n(): Promise<void> {
  const info = await invoke<LanguageInfo>("get_language").catch(() => null);
  await i18n.use(initReactI18next).init({
    resources,
    lng: info?.language ?? "en",
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = i18n.language;
}

export function getLanguage(): Promise<LanguageInfo> {
  return invoke("get_language");
}

/** Save the choice ("system" follows the system) and switch to it, menu included. */
export async function setLanguage(preference: string): Promise<LanguageInfo> {
  const info = await invoke<LanguageInfo>("set_language", { preference });
  await show(info.language);
  return info;
}

/** The app's language, for formatting numbers and dates */
export const locale = () => i18n.language || "en";

export default i18n;
