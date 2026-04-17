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
}

export function UpdateDialog({ open, onOpenChange }: UpdateDialogProps) {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

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
      toast.success(`Stoolap Desktop ${info.version} installed — restarting…`);
      await native.relaunchApp();
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Software Update
          </DialogTitle>
        </DialogHeader>

        <div className="py-2 space-y-3 text-sm">
          {status.kind === "checking" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking for updates…
            </div>
          )}

          {status.kind === "uptodate" && (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>
                You&apos;re on the latest version ({status.currentVersion}).
              </span>
            </div>
          )}

          {status.kind === "available" && (
            <div className="space-y-2">
              <p>
                <span className="font-medium">{status.info.version}</span>{" "}
                is available (you have {status.info.currentVersion}).
              </p>
              {status.info.body && (
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-48 overflow-auto bg-muted/30 rounded p-2">
                  {status.info.body}
                </pre>
              )}
            </div>
          )}

          {status.kind === "downloading" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Downloading… {status.percent}%
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
              Restarting…
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
                Later
              </Button>
              <Button onClick={handleInstall} className="gap-2">
                <Download className="h-4 w-4" />
                Install & Restart
              </Button>
            </>
          )}
          {(status.kind === "uptodate" ||
            status.kind === "error") && (
            <>
              <Button variant="ghost" onClick={runCheck} className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Check Again
              </Button>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
