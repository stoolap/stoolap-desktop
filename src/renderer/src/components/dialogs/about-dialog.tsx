import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as native from "@/lib/native";

/**
 * `SELECT VERSION()` returns
 *   "stoolap 0.5.0 (commit: <sha>, built: <time>)"
 * A build from crates.io reports "commit: unknown", so the commit is shown
 * only when it is a real hash.
 */
function engineLabel(raw: string): string {
  const match = raw.match(/^stoolap\s+(\S+)\s+\(commit:\s*([^,]+),/i);
  if (!match) return raw;
  const [, version, commit] = match;
  return /^[0-9a-f]{7,}$/i.test(commit)
    ? `Engine v${version} · ${commit.slice(0, 7)}`
    : `Engine v${version}`;
}

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [version, setVersion] = useState("");
  const [engine, setEngine] = useState("");

  useEffect(() => {
    if (open) {
      native.getVersion().then(setVersion);
      native.getStoolapVersion().then(setEngine);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[320px] p-8 text-center">
        <div className="flex justify-center mb-4">
          <img src="/icon.png" alt="Stoolap" width="80" height="80" className="rounded-2xl" />
        </div>

        <h2 className="text-lg font-semibold">Stoolap Desktop</h2>
        <p className="text-sm text-muted-foreground mt-1">Version {version}</p>

        {engine && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="text-xs text-muted-foreground mt-1 cursor-help">
                {engineLabel(engine)}
              </p>
            </TooltipTrigger>
            <TooltipContent className="font-data text-xs">{engine}</TooltipContent>
          </Tooltip>
        )}

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
