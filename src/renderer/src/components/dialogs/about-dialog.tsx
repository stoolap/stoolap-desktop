import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import * as native from "@/lib/native";

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (open) {
      native.getVersion().then(setVersion);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[320px] p-8 text-center">
        {/* Stoolap icon */}
        <div className="flex justify-center mb-4">
          <img src="/icon.png" alt="Stoolap" width="80" height="80" className="rounded-2xl" />
        </div>

        <h2 className="text-lg font-semibold">Stoolap Desktop</h2>
        <p className="text-sm text-muted-foreground mt-1">Version {version}</p>
        <p className="text-xs text-muted-foreground mt-0.5">Powered by Tauri</p>
        <p className="text-sm text-muted-foreground mt-3">
          Native database management for Stoolap
        </p>
        <p className="text-xs text-muted-foreground mt-3">
          Copyright &copy; 2025 Stoolap
          <br />
          Apache License 2.0
        </p>
      </DialogContent>
    </Dialog>
  );
}
