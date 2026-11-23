
import { useState, useRef, useCallback, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { errorMessage, basename } from "@/lib/utils";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useConnectionStore } from "@/stores/connection-store";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, FileInput, FileUp } from "lucide-react";
import { toast } from "sonner";
import * as api from "@/lib/api-client";
import * as native from "@/lib/native";

interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RestoreDialog({ open, onOpenChange }: RestoreDialogProps) {
  const { t } = useTranslation("dialogs");
  const activeId = useConnectionStore((s) => s.activeId);
  const connections = useConnectionStore((s) => s.connections);
  const activeConn = connections.find((c) => c.id === activeId);
  const queryClient = useQueryClient();
  const [filePath, setFilePath] = useState("");
  const [statementCount, setStatementCount] = useState(0);
  const [reading, setReading] = useState(false);
  const [useTransaction, setUseTransaction] = useState(true);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const abortRef = useRef(false);

  const resetAndClose = () => {
    setFilePath("");
    setStatementCount(0);
    setUseTransaction(true);
    setLoading(false);
    setProgress({ current: 0, total: 0 });
    setError("");
    abortRef.current = false;
    onOpenChange(false);
  };

  // The dump is read in the backend, by its path: a large one (90 MB) would
  // not make it through the web view whole
  const chooseFile = useCallback(
    async (path: string) => {
      setError("");
      setFilePath(path);
      setStatementCount(0);
      setReading(true);
      try {
        setStatementCount(await api.restoreCount(path));
      } catch {
        setFilePath("");
        setError(t("restore.readFailed"));
      } finally {
        setReading(false);
      }
    },
    [t],
  );

  const handleFileSelect = async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [
        { name: t("common:fileTypes.sql"), extensions: ["sql"] },
        { name: t("common:fileTypes.all"), extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") chooseFile(selected);
  };

  // A file dropped on the window while this is open (the window takes drops,
  // so the drop area's own events never see a file)
  useEffect(() => {
    if (!open) return;
    return native.onDragDrop({
      over: (active) => setDragOver(active && !loading),
      drop: (paths) => {
        if (!loading && paths[0]) chooseFile(paths[0]);
      },
    });
  }, [open, loading, chooseFile]);

  const handleRestore = async () => {
    if (!activeId || !filePath) return;
    setLoading(true);
    setError("");
    abortRef.current = false;
    setProgress({ current: 0, total: statementCount });

    const unlisten = await listen<{ done: number; total: number }>("restore:progress", (e) =>
      setProgress({ current: e.payload.done, total: e.payload.total }),
    );
    try {
      const count = await api.restoreFile(activeId, filePath, useTransaction);

      queryClient.invalidateQueries({ queryKey: ["tables", activeId] });
      queryClient.invalidateQueries({ queryKey: ["views", activeId] });
      queryClient.invalidateQueries({ queryKey: ["columns", activeId] });
      queryClient.invalidateQueries({ queryKey: ["indexes", activeId] });
      queryClient.invalidateQueries({ queryKey: ["fks", activeId] });
      queryClient.invalidateQueries({ queryKey: ["rowcount", activeId] });
      queryClient.invalidateQueries({ queryKey: ["ddl", activeId] });

      const msg = t("restore.complete", { count });
      native.notify(t("restore.notifyTitle"), msg);
      toast.success(msg);
      resetAndClose();
    } catch (e) {
      setError(abortRef.current ? t("common:errors.restoreCancelled") : errorMessage(e));
    } finally {
      unlisten();
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (loading) {
      abortRef.current = true;
      api.cancelRestore();
    } else {
      resetAndClose();
    }
  };

  const pct =
    progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !loading) resetAndClose();
        else if (isOpen) onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileInput className="h-5 w-5" />
            {t("restore.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {activeConn && (
            <p className="text-sm text-muted-foreground">
              <Trans
                t={t}
                i18nKey="restore.intro"
                values={{ name: activeConn.name }}
                components={{ b: <span className="font-medium text-foreground" /> }}
              />
            </p>
          )}

          <div className="space-y-2">
            <Label>{t("restore.file")}</Label>
            <div
              className={`flex items-center justify-center border-2 border-dashed rounded-lg p-6 cursor-pointer transition-colors ${dragOver ? "border-primary bg-primary/10" : "hover:border-primary/50 hover:bg-muted/30"}`}
              onClick={!loading ? handleFileSelect : undefined}
            >
              {filePath ? (
                <div className="text-center">
                  <FileUp className="h-8 w-8 mx-auto mb-2 text-primary" />
                  <p className="text-sm font-medium">{basename(filePath)}</p>
                  <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground mt-1">
                    {reading && <Loader2 className="h-3 w-3 animate-spin" />}
                    {reading ? t("restore.reading") : t("restore.detected", { count: statementCount })}
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <FileUp className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {t("restore.dropHint")}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={useTransaction}
                onCheckedChange={(v) => setUseTransaction(!!v)}
                disabled={loading}
              />
              {t("restore.useTransaction")}
            </label>
            <p className="pl-6 text-xs text-muted-foreground">
              {t("restore.useTransactionHint")}
            </p>
          </div>

          {loading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("restore.executing")}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {progress.current}/{progress.total} ({pct}%)
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive whitespace-pre-wrap break-words">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {loading ? t("actions.cancel") : t("actions.close")}
          </Button>
          <Button
            onClick={handleRestore}
            disabled={loading || reading || !filePath || !activeId}
          >
            {loading ? t("restore.restoring") : t("restore.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
