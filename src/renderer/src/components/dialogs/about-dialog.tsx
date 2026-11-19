import { useState, useEffect, type ReactNode } from "react";
import { Check, Copy, FileText, Globe } from "lucide-react";
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

/** GitHub's mark (Octicons mark-github, MIT): lucide dropped brand icons */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
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
          <LinkButton icon={<GithubMark className="h-3.5 w-3.5" />} label="GitHub" url={REPO} />
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
