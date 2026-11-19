import type { EditorTab, RunEntry } from "@/lib/types";
import { basename } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";

/** Longest tab SQL the agent can read, and how many recent runs it gets */
const MAX_TAB_SQL = 20_000;
const MAX_RUNS = 50;

/** `ms` as local wall time with its UTC offset ("2026-11-19 14:03:12 +03:00"), as AS OF needs it */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** The error a tab's last run showed: a failed statement, or the one a script failed on */
export function tabError(tab: EditorTab | null | undefined): string | undefined {
  if (!tab) return undefined;
  if (tab.resultsError) return tab.resultsError;
  return tab.result && "error" in tab.result && tab.result.error ? tab.result.error : undefined;
}

/** A database's key: its path, or the connection id when in memory */
export function dbKeyOf(conn: { id: string; type: string; path: string }): string {
  return conn.type === "memory" ? conn.id : conn.path;
}

export interface TabSnapshot {
  id: string;
  title: string;
  sql: string;
  /** The tab the user is looking at */
  active: boolean;
  /** Where it last ran: this database or another (named), and when */
  ranOn?: "this" | "other";
  ranOnName?: string;
  lastRunAt?: string;
  /** The error its last run showed, if it failed */
  lastError?: string;
}

export type RunSnapshot = RunEntry & { time: string };

/**
 * What the agent may read of the editor for the database `db`: the query
 * tabs and that database's recent runs. Taken when a request starts and
 * again after each of its writes, so list_tabs and query_history are current.
 */
export function editorSnapshot(
  db: string,
  /** The tab the user is looking at; the front tab when left out */
  lookingAt?: string,
): { tabs: TabSnapshot[]; runs: RunSnapshot[] } {
  const { tabs, runLog, activeTabId } = useEditorStore.getState();
  const active = lookingAt ?? activeTabId;
  const connections = useConnectionStore.getState().connections ?? [];
  // The open database's current name; else the name it had when the tab ran there
  const nameOf = (key: string, then?: string) =>
    connections.find((c) => dbKeyOf(c) === key)?.name ??
    then ??
    // Runs from before names were kept: a path still says which, an id doesn't
    (/[\\/]/.test(key) ? basename(key) : `a closed in-memory database (${key.slice(0, 8)})`);
  return {
    tabs: tabs
      .filter((t) => t.mode === "query")
      .map((t) => ({
        id: t.id,
        title: t.title,
        sql: t.sql.slice(0, MAX_TAB_SQL),
        active: t.id === active,
        // Tabs aren't tied to a database; where one last ran tells them apart
        ranOn: t.lastDb === undefined ? undefined : t.lastDb === db ? "this" : "other",
        ranOnName: t.lastDb !== undefined && t.lastDb !== db ? nameOf(t.lastDb, t.lastDbName) : undefined,
        lastRunAt: t.lastRunAt ? localTime(t.lastRunAt) : undefined,
        lastError: tabError(t)?.slice(0, 500),
      })),
    runs: runLog
      .filter((r) => r.db === db)
      .slice(0, MAX_RUNS)
      .map((r) => ({ ...r, time: localTime(r.at) })),
  };
}
