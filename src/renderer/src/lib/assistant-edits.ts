import * as assistant from "@/lib/assistant";
import type { StatementOutcome, WriteOutcome } from "@/lib/assistant";
import { isSingleReadOnly } from "@/lib/sql-utils";
import type { ApiResult, DdlResult, ExecResult, QueryResult, ScriptResult } from "@/lib/types";
import { useAssistantStore } from "@/stores/assistant-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";

/** A request to run SQL in a tab, served by that tab's QueryToolbar. */
export interface RunTabRequest {
  tabId: string;
  sql: string;
  /** Run only while this connection is the active one */
  connId?: string;
  /** Set by the toolbar when it takes the request */
  handled?: boolean;
  done: (result: ApiResult | ScriptResult | undefined) => void;
}

/**
 * Run `sql` in its editor tab through the tab's own toolbar, so Stop, the
 * timeout, history and the result grid work as for any run. Resolves with
 * what the tab shows, or undefined when no toolbar took the request.
 */
export function runInTab(tabId: string, sql: string): Promise<ApiResult | ScriptResult | undefined> {
  useEditorStore.getState().setActiveTab(tabId);
  // Let the tab's toolbar mount before it hears the request
  return nextFrame().then(() => dispatchRun(tabId, sql));
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Hand `sql` to the (mounted) tab's toolbar, which starts it at once. */
function dispatchRun(tabId: string, sql: string, connId?: string): Promise<ApiResult | ScriptResult | undefined> {
  return new Promise((resolve) => {
    const detail: RunTabRequest = { tabId, sql, connId, done: resolve };
    window.dispatchEvent(new CustomEvent("stoolap:run-tab", { detail }));
    if (!detail.handled) resolve(undefined);
  });
}

/** How long the SQL shows before it runs, and the result before the assistant goes on */
const READ_SQL_MS = 700;
const SEE_RESULT_MS = 1500;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Conversations the user stopped: their writes never run, until the next request */
const stopped = new Set<string>();

/** A new request starts: its writes may run. */
export function startWrites(conversationId: string): void {
  stopped.delete(conversationId);
}

/** The user stopped the conversation: writes it has not run yet never run. */
export function stopWrites(conversationId: string): void {
  stopped.add(conversationId);
}

/**
 * Why a write that was going to run must not run now, checked right before
 * it runs: the user may have stopped or deleted the conversation, switched
 * to another database, or taken back write access while it waited.
 */
function blockedReason(
  conversationId: string,
  w: { connId: string; sql: string; allowWrites: boolean },
): string | null {
  const assistantState = useAssistantStore.getState();
  const conversation = assistantState.conversations[conversationId];
  if (!conversation || stopped.has(conversationId)) return "the user stopped the request";
  if (useConnectionStore.getState().activeId !== w.connId) {
    return "the user switched to another database; it is in the tab, not run";
  }
  if (!isSingleReadOnly(w.sql) && !(w.allowWrites && assistantState.writeAccess[conversation.dbKey])) {
    return "the user turned off Run writes; it waits in the tab for the user to run it";
  }
  return null;
}

/** Requested tab -> the tab actually written to (a new one if it was closed) */
const tabFor = new Map<string, string>();
/** Requested tab -> its SQL before the assistant started writing, for Undo */
const beforeWrite = new Map<string, string>();

function resolveTab(tabId: string): string {
  const editor = useEditorStore.getState();
  const exists = (id: string) => editor.tabs.some((t) => t.id === id && t.mode === "query");
  const known = tabFor.get(tabId);
  if (known && exists(known)) return known;
  const id = exists(tabId) ? tabId : editor.addTab("Assistant", "");
  tabFor.set(tabId, id);
  return id;
}

/** write_query's SQL streaming in: show it in the tab as it arrives. */
export function applyDraft(tabId: string, sql: string): void {
  const id = resolveTab(tabId);
  const editor = useEditorStore.getState();
  if (!beforeWrite.has(tabId)) {
    beforeWrite.set(tabId, editor.tabs.find((t) => t.id === id)?.sql ?? "");
  }
  if (editor.activeTabId !== id) editor.setActiveTab(id);
  editor.updateTabSql(id, sql);
}

function statementOutcome(r: QueryResult | ExecResult | DdlResult): StatementOutcome {
  if ("columns" in r) return { columns: r.columns, rows: r.rows.slice(0, 50), rowCount: r.rows.length };
  if ("changes" in r) return { changes: r.changes };
  return { ddl: r.ddl };
}

function outcomeOf(result: ApiResult | ScriptResult | undefined): WriteOutcome {
  if (!result) return { ran: false, reason: "the tab could not run it" };
  if ("error" in result && result.error) return { ran: true, error: result.error };
  if ("results" in result) return { ran: true, statements: result.results.map(statementOutcome) };
  return { ran: true, ...statementOutcome(result as QueryResult | ExecResult | DdlResult) };
}

/**
 * write_query's complete SQL: write it into the tab, run it there when it
 * only reads (or the user allows writes), record it in the panel (with Undo),
 * and report the outcome to the assistant. Otherwise it waits for the user's
 * Run.
 */
export async function applyWrite(
  conversationId: string,
  w: { requestId: string; connId: string; tabId: string; sql: string; explanation: string; allowWrites: boolean },
): Promise<void> {
  const id = resolveTab(w.tabId);
  const editor = useEditorStore.getState();
  const before = beforeWrite.get(w.tabId) ?? editor.tabs.find((t) => t.id === id)?.sql ?? "";
  beforeWrite.delete(w.tabId);
  tabFor.delete(w.tabId);
  editor.updateTabSql(id, w.sql);
  editor.setActiveTab(id);

  // Reads always run; anything else only with the user's permission
  const runs = isSingleReadOnly(w.sql) || w.allowWrites;
  const itemId = useAssistantStore.getState().addProposal(conversationId, {
    kind: "proposal",
    tabId: id,
    before,
    sql: w.sql,
    explanation: w.explanation,
    applied: true,
    autoRan: runs,
  });

  let outcome: WriteOutcome = { ran: false };
  try {
    if (runs) {
      // Paced so the user can follow: read the SQL, then see its result,
      // before the assistant moves on to its next step
      await pause(READ_SQL_MS);
      useEditorStore.getState().setActiveTab(id);
      await nextFrame();
      // Checked with nothing async between it and the run starting
      const reason = blockedReason(conversationId, w);
      if (reason) {
        outcome = { ran: false, reason };
        useAssistantStore.getState().setNotRun(conversationId, itemId);
      } else {
        outcome = outcomeOf(await dispatchRun(id, w.sql, w.connId));
        await pause(SEE_RESULT_MS);
      }
    }
  } finally {
    // The assistant waits for this
    assistant.writeResult(w.requestId, outcome).catch(() => {});
  }
}
