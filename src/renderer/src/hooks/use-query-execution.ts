import { useCallback } from "react";
import { errorMessage } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";
import { queryTimeoutLabel, useSettingsStore } from "@/stores/settings-store";
import { useQueryClient } from "@tanstack/react-query";
import { splitStatements } from "@/lib/sql-utils";
import * as api from "@/lib/api-client";
import * as native from "@/lib/native";
import type { ApiResult, ScriptResult } from "@/lib/types";

function isDDL(sql: string): boolean {
  const upper = sql.trimStart().toUpperCase();
  return (
    upper.startsWith("CREATE") ||
    upper.startsWith("DROP") ||
    upper.startsWith("ALTER") ||
    upper.startsWith("TRUNCATE")
  );
}


const NOTIFY_AFTER_MS = 10_000;

/** A native notification for a long query that finished while the window was in the background. */
function notifyIfLong(tabId: string, result: ApiResult | ScriptResult, elapsedMs: number) {
  if (elapsedMs < NOTIFY_AFTER_MS || (!document.hidden && document.hasFocus())) return;
  const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
  const secs = Math.round(elapsedMs / 1000);
  const outcome =
    result.error !== undefined
      ? `Failed after ${secs} s: ${result.error}`
      : "results" in result
        ? `${result.results.length} statements in ${secs} s`
        : "rows" in result
        ? `${result.rows.length.toLocaleString()} rows in ${secs} s`
        : "changes" in result
          ? `${result.changes.toLocaleString()} rows changed in ${secs} s`
          : `Done in ${secs} s`;
  native.notify(`${tab?.title ?? "Query"} finished`, outcome);
}

/**
 * The engine has no way to interrupt a statement from outside, so Stop only
 * stops waiting; the timeout is what ends the statement.
 */
function stoppedMessage(): string {
  const ms = useSettingsStore.getState().queryTimeoutMs;
  return ms === 0
    ? "Stopped waiting. The query keeps running in the background until it finishes."
    : `Stopped waiting. The query keeps running in the background until it finishes or reaches the ${queryTimeoutLabel(ms)} timeout.`;
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

export function useQueryExecution() {
  const activeId = useConnectionStore((s) => s.activeId);
  const queryClient = useQueryClient();

  const executeQuery = useCallback(
    /**
     * Run `sql` in the tab; resolves to what the tab ended up showing.
     * With `onlyOn`, it runs only while that connection is the active one.
     */
    async (tabId: string, sql: string, onlyOn?: string): Promise<ApiResult | ScriptResult | undefined> => {
      if (!activeId || !sql.trim()) return undefined;
      if (onlyOn && onlyOn !== useConnectionStore.getState().activeId) return undefined;

      const { setTabRunning, setTabLastExecutedSql, addToHistory } =
        useEditorStore.getState();

      const controller = startRun(tabId);

      setTabRunning(tabId, true);
      setTabLastExecutedSql(tabId, sql.trim());
      addToHistory(sql.trim());

      const started = Date.now();
      try {
        const result = await api.executeQuery(activeId, sql, controller.signal);
        if (controller.signal.aborted) {
          const stopped = { error: stoppedMessage() };
          useEditorStore.getState().setTabResult(tabId, stopped);
          return stopped;
        }
        if ("results" in result) {
          useEditorStore.getState().setTabResults(tabId, result.results);
        } else {
          useEditorStore.getState().setTabResult(tabId, result);
        }
        notifyIfLong(tabId, result, Date.now() - started);

        // Refresh schema sidebar after DDL statements (scoped to active connection)
        const statements = splitStatements(sql);
        if (statements.some(isDDL)) {
          queryClient.invalidateQueries({ queryKey: ["tables", activeId] });
          queryClient.invalidateQueries({ queryKey: ["views", activeId] });
          queryClient.invalidateQueries({ queryKey: ["columns", activeId] });
          queryClient.invalidateQueries({ queryKey: ["indexes", activeId] });
          queryClient.invalidateQueries({ queryKey: ["fks", activeId] });
          queryClient.invalidateQueries({ queryKey: ["rowcount", activeId] });
          queryClient.invalidateQueries({ queryKey: ["ddl", activeId] });
          queryClient.invalidateQueries({ queryKey: ["tableRows", activeId] });
          queryClient.invalidateQueries({ queryKey: ["tableRowCount", activeId] });
        }
        return result;
      } catch (e) {
        if (controller.signal.aborted) {
          const stopped = { error: stoppedMessage() };
          useEditorStore.getState().setTabResult(tabId, stopped);
          return stopped;
        }
        const failed = { error: errorMessage(e) };
        useEditorStore.getState().setTabResult(tabId, failed);
        return failed;
      } finally {
        endRun(tabId, controller);
      }
    },
    [activeId, queryClient],
  );

  return { executeQuery, cancelQuery: stopRuns, isConnected: !!activeId };
}
