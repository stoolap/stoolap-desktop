import { useCallback, useEffect, useRef } from "react";
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

export function useQueryExecution() {
  const activeId = useConnectionStore((s) => s.activeId);
  const queryClient = useQueryClient();
  const abortMapRef = useRef<Map<string, AbortController>>(new Map());

  // Abort all pending queries on unmount
  useEffect(() => {
    const map = abortMapRef.current;
    return () => {
      for (const controller of map.values()) {
        controller.abort();
      }
      map.clear();
    };
  }, []);

  const executeQuery = useCallback(
    /** Run `sql` in the tab; resolves to what the tab ended up showing. */
    async (tabId: string, sql: string): Promise<ApiResult | ScriptResult | undefined> => {
      if (!activeId || !sql.trim()) return undefined;

      const { setTabRunning, setTabLastExecutedSql, addToHistory } =
        useEditorStore.getState();

      // Cancel any running query for THIS tab
      abortMapRef.current.get(tabId)?.abort();
      const controller = new AbortController();
      abortMapRef.current.set(tabId, controller);

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
        abortMapRef.current.delete(tabId);
      }
    },
    [activeId, queryClient],
  );

  const cancelQuery = useCallback((tabId?: string) => {
    if (tabId) {
      abortMapRef.current.get(tabId)?.abort();
    } else {
      // Cancel all running queries
      for (const controller of abortMapRef.current.values()) {
        controller.abort();
      }
    }
  }, []);

  return { executeQuery, cancelQuery, isConnected: !!activeId };
}
