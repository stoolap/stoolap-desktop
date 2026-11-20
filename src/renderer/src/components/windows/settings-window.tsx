import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLanguage, LANGUAGES, setLanguage, type LanguageInfo } from "@/lib/i18n";
import { errorMessage } from "@/lib/utils";

const nameOf = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

/** The Settings window. Its picker is the system's own pop-up menu. */
export function SettingsWindow() {
  const { t } = useTranslation("dialogs");
  const [info, setInfo] = useState<LanguageInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getLanguage().then(setInfo, () => setInfo(null));
  }, []);

  const choose = (preference: string) => {
    setError("");
    setLanguage(preference).then(setInfo, (e) => setError(errorMessage(e)));
  };

  return (
    <div className="space-y-2 p-5">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="settings-language" className="text-sm font-medium">
          {t("settings.language")}
        </label>
        <select
          id="settings-language"
          value={info?.preference ?? ""}
          onChange={(e) => choose(e.target.value)}
          disabled={!info}
          className="h-8 w-56 rounded-md border bg-background px-2 text-sm"
        >
          <option value="system">{t("settings.system", { language: nameOf(info?.system ?? "en") })}</option>
          <hr />
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code} lang={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
