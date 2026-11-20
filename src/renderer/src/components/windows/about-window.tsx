import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
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

function Link({ label, url }: { label: string; url: string }) {
  return (
    <button
      type="button"
      onClick={() => agent.openLink(url).catch((e) => toast.error(String(e)))}
      className="text-primary hover:underline"
    >
      {label}
    </button>
  );
}

/**
 * The About window, as macOS' own: the icon, the name and a few centred
 * lines. The versions can be selected and copied, for a bug report.
 */
export function AboutWindow() {
  const { t } = useTranslation("dialogs");
  const [version, setVersion] = useState("");
  const [engine, setEngine] = useState("");

  useEffect(() => {
    native.getVersion().then(setVersion);
    native.getStoolapVersion().then(setEngine);
  }, []);

  return (
    <div className="flex flex-col items-center px-6 pt-6 pb-6 text-center">
      <img
        src="/icon.png"
        alt=""
        width={64}
        height={64}
        className="rounded-[14px] shadow-sm"
        draggable={false}
      />
      <h1 className="mt-3 text-base font-semibold">Stoolap Desktop</h1>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("about.tagline")}</p>

      <div className="allow-select mt-4 text-xs leading-relaxed text-muted-foreground">
        <p>
          {t("about.version")} {version}
        </p>
        {engine && (
          <p>{t("about.poweredBy", { engine: engineLabel(engine) })}</p>
        )}
      </div>

      <p className="mt-4 text-xs">
        <Link label={t("about.website")} url="https://stoolap.io" />
        <span className="mx-1.5 text-muted-foreground">·</span>
        <Link label="GitHub" url={REPO} />
        <span className="mx-1.5 text-muted-foreground">·</span>
        <Link
          label={t("about.changelog")}
          url={version ? `${REPO}/releases/tag/v${version}` : `${REPO}/releases`}
        />
      </p>

      <p className="mt-4 text-[11px] text-muted-foreground">
        © 2025–{new Date().getFullYear()} Stoolap · Apache License 2.0
      </p>
    </div>
  );
}
