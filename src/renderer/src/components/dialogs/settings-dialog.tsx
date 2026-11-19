import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getLanguage, LANGUAGES, setLanguage, type LanguageInfo } from "@/lib/i18n";
import { errorMessage } from "@/lib/utils";

const nameOf = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("dialogs");
  const [info, setInfo] = useState<LanguageInfo | null>(null);

  useEffect(() => {
    if (open) getLanguage().then(setInfo, () => setInfo(null));
  }, [open]);

  const choose = (preference: string) =>
    setLanguage(preference).then(setInfo, (e) => toast.error(errorMessage(e)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="settings-language" className="text-sm font-medium">
              {t("settings.language")}
            </label>
            <Select value={info?.preference} onValueChange={choose} disabled={!info}>
              <SelectTrigger id="settings-language" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">
                  {t("settings.system", { language: nameOf(info?.system ?? "en") })}
                </SelectItem>
                <SelectSeparator />
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code} lang={l.code}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
