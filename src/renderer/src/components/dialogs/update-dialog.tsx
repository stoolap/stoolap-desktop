import { useEffect, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { MessageText } from "@/components/agent/message-text";
import * as native from "@/lib/native";
import { errorMessage } from "@/lib/utils";

type Status =
  | { kind: "checking" }
  | { kind: "uptodate"; currentVersion: string }
  | { kind: "available"; info: native.UpdateInfo; apply: (cb?: (p: native.UpdateProgress) => void) => Promise<void> }
  | { kind: "downloading"; percent: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Closed with an update offered and not taken (Later, the X, Esc) */
  onLater?: () => void;
}

export function UpdateDialog({ open, onOpenChange: setOpen, onLater }: UpdateDialogProps) {
  const { t } = useTranslation("dialogs");
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  const onOpenChange = (next: boolean) => {
    if (!next && status.kind === "available") onLater?.();
    setOpen(next);
  };

  const runCheck = useCallback(async () => {
    setStatus({ kind: "checking" });
    try {
      const result = await native.checkForUpdate();
      if (!result.available) {
        const currentVersion = await native.getVersion();
        setStatus({ kind: "uptodate", currentVersion });
      } else {
        setStatus({ kind: "available", info: result.info, apply: result.apply });
      }
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    if (open) runCheck();
  }, [open, runCheck]);

  const handleInstall = async () => {
    if (status.kind !== "available") return;
    const { apply, info } = status;
    try {
      setStatus({ kind: "downloading", percent: 0 });
      await apply((p) => {
        if (p.kind === "progress" && p.contentLength) {
          const percent = Math.round((p.downloaded / p.contentLength) * 100);
          setStatus({ kind: "downloading", percent });
        } else if (p.kind === "finished") {
          setStatus({ kind: "ready" });
        }
      });
      toast.success(t("update.installed", { version: info.version }));
      await native.relaunchApp();
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Nothing focused on open: the X would show selected */}
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            {t("update.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="py-2 space-y-3 text-sm">
          {status.kind === "checking" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("update.checking")}
            </div>
          )}

          {status.kind === "uptodate" && (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>
                {t("update.upToDate", { version: status.currentVersion })}
              </span>
            </div>
          )}

          {status.kind === "available" && (
            <div className="space-y-2">
              <p>
                <Trans
                  t={t}
                  i18nKey="update.available"
                  values={{ version: status.info.version, current: status.info.currentVersion }}
                  components={{ b: <span className="font-medium" /> }}
                />
              </p>
              {status.info.body && (
                <div className="max-h-64 overflow-auto rounded bg-muted/30 p-3">
                  <MessageText text={status.info.body} />
                </div>
              )}
            </div>
          )}

          {status.kind === "downloading" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("update.downloading", { percent: status.percent })}
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${status.percent}%` }}
                />
              </div>
            </div>
          )}

          {status.kind === "ready" && (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              {t("update.restarting")}
            </div>
          )}

          {status.kind === "error" && (
            <p className="text-destructive">{status.message}</p>
          )}
        </div>

        <DialogFooter>
          {status.kind === "available" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("update.later")}
              </Button>
              <Button onClick={handleInstall} className="gap-2">
                <Download className="h-4 w-4" />
                {t("update.install")}
              </Button>
            </>
          )}
          {(status.kind === "uptodate" ||
            status.kind === "error") && (
            <>
              <Button variant="outline" onClick={runCheck} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                {t("update.checkAgain")}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t("actions.close")}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
