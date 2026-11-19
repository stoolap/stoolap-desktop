import { useState, useEffect, type ReactNode } from "react";
import { Check, Copy, FileText, Github, Globe } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as agent from "@/lib/agent";
import * as native from "@/lib/native";

const REPO = "https://github.com/stoolap/stoolap-desktop";

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
    ? `Stoolap ${version} · ${commit.slice(0, 7)}`
    : `Stoolap ${version}`;
}

function Row({ label, mono = true, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-data truncate" : "truncate"}>{children}</span>
    </div>
  );
}

function LinkButton({ icon, label, url }: { icon: ReactNode; label: string; url: string }) {
  return (
    <button
      type="button"
      onClick={() => agent.openLink(url).catch((e) => toast.error(String(e)))}
      className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      {icon}
      {label}
    </button>
  );
}

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("dialogs");
  const [version, setVersion] = useState("");
  const [engine, setEngine] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setCopied(false);
      native.getVersion().then(setVersion);
      native.getStoolapVersion().then(setEngine);
    }
  }, [open]);

  // For bug reports: the app's and the engine's exact versions
  const copyVersions = () =>
    navigator.clipboard.writeText(`Stoolap Desktop ${version}\n${engine}`).then(
      () => setCopied(true),
      () => toast.error(t("about.copyFailed")),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Nothing focused on open: the X or a link would show selected */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 p-0 sm:max-w-[340px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex flex-col items-center px-6 pt-7 pb-5 text-center">
          <img
            src="/icon.png"
            alt=""
            width={64}
            height={64}
            className="rounded-[14px] shadow-sm"
            draggable={false}
          />
          <DialogTitle className="mt-3 text-base">Stoolap Desktop</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            {t("about.tagline")}
          </DialogDescription>
        </div>

        <div className="mx-5 rounded-md border bg-muted/30 py-1 text-xs">
          <Row label={t("about.version")}>{version}</Row>
          <Row label={t("about.engine")}>
            {engine && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">{engineLabel(engine)}</span>
                </TooltipTrigger>
                <TooltipContent className="font-data text-xs">{engine}</TooltipContent>
              </Tooltip>
            )}
          </Row>
          <Row label={t("about.builtWith")} mono={false}>Tauri 2</Row>
          <button
            type="button"
            onClick={copyVersions}
            className="mt-1 flex w-full items-center justify-center gap-1 border-t px-3 pt-2 pb-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? t("about.copied") : t("about.copyVersions")}
          </button>
        </div>

        {/* Wraps instead of widening the window when the labels run long */}
        <div className="mx-5 mt-3 flex flex-wrap justify-center gap-x-1">
          <LinkButton icon={<Globe className="h-3.5 w-3.5" />} label={t("about.website")} url="https://stoolap.io" />
          <LinkButton icon={<Github className="h-3.5 w-3.5" />} label="GitHub" url={REPO} />
          <LinkButton
            icon={<FileText className="h-3.5 w-3.5" />}
            label={t("about.changelog")}
            url={version ? `${REPO}/releases/tag/v${version}` : `${REPO}/releases`}
          />
        </div>

        <p className="mt-3 border-t px-6 py-3 text-center text-[11px] text-muted-foreground">
          © 2025–{new Date().getFullYear()} Stoolap · Apache License 2.0
        </p>
      </DialogContent>
    </Dialog>
  );
}
