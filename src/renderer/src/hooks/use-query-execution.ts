import { useCallback } from "react";
import { errorMessage } from "@/lib/utils";
import i18n from "@/lib/i18n";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";
import { queryTimeoutLabel, useSettingsStore } from "@/stores/settings-store";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { explainKind, hasReturning, isSingleReadOnly } from "@/lib/sql-utils";
import * as api from "@/lib/api-client";
import * as native from "@/lib/native";
import type { ApiResult, RunEntry, ScriptResult } from "@/lib/types";
import { dbKeyOf } from "@/lib/agent-context";

/** Reload the sidebar and open data tabs of the connection. */
function refreshSchema(queryClient: QueryClient, connId: string) {
  for (const key of ["tables", "views", "columns", "indexes", "fks", "rowcount", "ddl", "tableRows", "tableRowCount"]) {
    queryClient.invalidateQueries({ queryKey: [key, connId] });
  }
}

const NOTIFY_AFTER_MS = 10_000;

/** A native notification for a long query that finished while the window was in the background. */
function notifyIfLong(tabId: string, result: ApiResult | ScriptResult, elapsedMs: number) {
  if (elapsedMs < NOTIFY_AFTER_MS || (!document.hidden && document.hasFocus())) return;
  const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
  const secs = Math.round(elapsedMs / 1000);
  const outcome =
    result.error !== undefined
      ? i18n.t("editor:run.failedAfter", { secs, error: result.error })
      : "results" in result
        ? i18n.t("editor:run.statements", { count: result.results.length, secs })
        : "rows" in result
        ? i18n.t("editor:run.rows", { count: result.rows.length, secs })
        : "changes" in result
          ? i18n.t("editor:run.changed", { count: result.changes, secs })
          : i18n.t("editor:run.done", { secs });
  native.notify(i18n.t("editor:run.finished", { title: tab?.title ?? i18n.t("editor:tabs.defaultTitle") }), outcome);
}

/**
 * The engine has no way to interrupt a statement from outside, so Stop only
 * stops waiting; the timeout is what ends the statement.
 */
function stoppedMessage(): string {
  const ms = useSettingsStore.getState().queryTimeoutMs;
  return ms === 0
    ? i18n.t("editor:run.stopped")
    : i18n.t("editor:run.stoppedTimeout", { timeout: queryTimeoutLabel(ms) });
}

/**
 * The run each tab is waiting on, shared by every component that runs or
 * stops queries (toolbar, editor, shortcuts, tabs), so Stop finds a run
 * whichever one started it.
 */
const runs = new Map<string, AbortController>();

/** Start a run in the tab, stopping the wait on the one before it. */
export function startRun(tabId: string): AbortController {
  runs.get(tabId)?.abort();
  const controller = new AbortController();
  runs.set(tabId, controller);
  return controller;
}

/** A run ended; a newer run in the same tab stays registered. */
export function endRun(tabId: string, controller: AbortController): void {
  if (runs.get(tabId) === controller) runs.delete(tabId);
}

/** Stop waiting on the tab's run, or on every run. */
export function stopRuns(tabId?: string): void {
  if (tabId) runs.get(tabId)?.abort();
  else for (const controller of runs.values()) controller.abort();
}

/**
 * A run the user stopped, or one a newer run in the tab replaced. Only the
 * tab's current run shows it: a replaced one leaves the newer run's
 * spinner and Stop alone.
 */
function stopped(tabId: string, controller: AbortController): ApiResult {
  const result = { error: stoppedMessage() };
  if (runs.get(tabId) === controller) useEditorStore.getState().setTabResult(tabId, result);
  return result;
}

/** The database a connection is: its path, or its id when in memory */
function dbKey(connId: string): string {
  const conn = useConnectionStore.getState().connections?.find((c) => c.id === connId);
  return conn ? dbKeyOf(conn) : connId;
}

/**
 * How the run touched the user's transaction, from whether one was open
 * before and after it: the status bar shows an open one, and the run log
 * marks the run (so the agent can tell what was never committed).
 */
async function settleTransaction(connId: string): Promise<RunEntry["transaction"]> {
  const before = !!useConnectionStore.getState().openTransactions?.[connId];
  const open = await api.transactionOpen(connId).catch(() => false);
  useConnectionStore.getState().setTransactionOpen(connId, open);
  if (open) return before ? "inside" : "opened";
  return before ? "ended" : undefined;
}

/** A script's statements kept in the run log, each with its result */
const MAX_STEPS = 30;

/** Keep the run in the log the agent reads (its query_history tool). */
function logRun(
  connId: string,
  tabId: string,
  sql: string,
  result: ApiResult | ScriptResult,
  ms: number,
  at: number,
  by?: "agent",
  transaction?: RunEntry["transaction"],
) {
  const db = dbKey(connId);
  const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId)?.title;
  const run: RunEntry = {
    sql: sql.trim().slice(0, 4000),
    at,
    ms: Math.round(ms * 100) / 100,
    db,
    tab,
    by,
    transaction,
  };
  // A script keeps its statements' results even when one failed
  if ("error" in result && result.error) run.error = result.error;
  if ("results" in result) {
    // All of the script: what ran, the one it failed on, and the rest
    run.statements = result.results.length + (result.failed ? 1 : 0) + (result.notRun?.length ?? 0);
    run.rolledBack = result.rolledBack || undefined;
    const short = (sql: string) => (sql.length > 200 ? `${sql.slice(0, 200)}…` : sql);
    run.steps = [
      ...result.results.map((r) => ({
        sql: short(r.sql),
        ms: r.time,
        ...("rows" in r
          ? { rows: r.rows.length, writes: hasReturning(r.sql) || undefined, plan: explainKind(r.sql) }
          : "changes" in r
            ? { changes: r.changes }
            : { ddl: r.ddl }),
      })),
      // The one it failed on, and those that never ran
      ...(result.failed ? [{ sql: short(result.failed), status: "failed" as const }] : []),
      ...(result.notRun ?? []).map((sql) => ({ sql: short(sql), status: "not run" as const })),
    ].slice(0, MAX_STEPS);
  } else if (!run.error) {
    if ("rows" in result) {
      run.rows = result.rows.length;
      // A write's RETURNING rows: what it changed, not what it read
      if (hasReturning(sql)) run.writes = true;
      run.plan = explainKind(sql);
    }
    else if ("changes" in result) run.changes = result.changes;
    else if ("ddl" in result) run.ddl = result.ddl;
  }
  useEditorStore.getState().addRun(run);
}

export function useQueryExecution() {
  const activeId = useConnectionStore((s) => s.activeId);
  const queryClient = useQueryClient();

  const executeQuery = useCallback(
    /**
     * Run `sql` in the tab; resolves to what the tab ended up showing.
     * With `onlyOn`, it runs only while that connection is the active one.
     * `by` marks a run the agent asked for, in the run log.
     */
    async (tabId: string, sql: string, onlyOn?: string, by?: "agent"): Promise<ApiResult | ScriptResult | undefined> => {
      if (!activeId || !sql.trim()) return undefined;
      if (onlyOn && onlyOn !== useConnectionStore.getState().activeId) return undefined;

      const { setTabRunning, setTabLastExecutedSql, addToHistory } =
        useEditorStore.getState();

      const controller = startRun(tabId);

      setTabRunning(tabId, true);
      // The run's start: the tab's last run and the log entry share it, and
      // it is the moment AS OF needs for "before this ran"
      const startedAt = Date.now();
      const conn = useConnectionStore.getState().connections?.find((c) => c.id === activeId);
      setTabLastExecutedSql(tabId, sql.trim(), { key: dbKey(activeId), name: conn?.name ?? activeId, at: startedAt });
      addToHistory(sql.trim());

      const started = performance.now();
      try {
        const result = await api.executeQuery(activeId, sql, controller.signal);
        if (controller.signal.aborted) return stopped(tabId, controller);
        // Show what the user waited for, from the request to the parsed rows:
        // the engine's own time leaves out sending a large result over
        if ("time" in result) result.time = Math.round((performance.now() - started) * 100) / 100;
        if ("results" in result) {
          useEditorStore.getState().setTabResults(tabId, result.results, result.time, result.error);
        } else {
          useEditorStore.getState().setTabResult(tabId, result);
        }
        notifyIfLong(tabId, result, performance.now() - started);
        const waited = performance.now() - started;
        logRun(activeId, tabId, sql, result, waited, startedAt, by, await settleTransaction(activeId));

        return result;
      } catch (e) {
        if (controller.signal.aborted) return stopped(tabId, controller);
        const failed = { error: errorMessage(e) };
        useEditorStore.getState().setTabResult(tabId, failed);
        const waited = performance.now() - started;
        logRun(activeId, tabId, sql, failed, waited, startedAt, by, await settleTransaction(activeId));
        return failed;
      } finally {
        endRun(tabId, controller);
        // Anything but a plain read may have changed tables, views, indexes
        // or rows, even when it failed partway through a script
        if (!controller.signal.aborted && !isSingleReadOnly(sql)) refreshSchema(queryClient, activeId);
      }
    },
    [activeId, queryClient],
  );

  return { executeQuery, cancelQuery: stopRuns, isConnected: !!activeId };
}
