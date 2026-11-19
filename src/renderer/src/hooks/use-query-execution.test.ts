import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** Each query waits until the test settles it, or its wait is stopped */
const pending: ((r: unknown) => void)[] = [];
vi.mock("@/lib/api-client", () => ({
  executeQuery: (_conn: string, _sql: string, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      pending.push(resolve);
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
}));

/** Connected to "conn" (a server render would read the store's initial state) */
vi.mock("@/stores/connection-store", () => {
  const state = { activeId: "conn" };
  return { useConnectionStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});

const { endRun, startRun, stopRuns, useQueryExecution } = await import("./use-query-execution");
const { useEditorStore } = await import("@/stores/editor-store");

/** The hook's executeQuery, taken from one render */
function executeQuery() {
  let run!: ReturnType<typeof useQueryExecution>["executeQuery"];
  const Probe = () => {
    run = useQueryExecution().executeQuery;
    return null;
  };
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  return run;
}

describe("query runs", () => {
  it("Stop reaches a run whichever component started it", () => {
    const run = startRun("tab-1");
    stopRuns("tab-1");
    expect(run.signal.aborted).toBe(true);
  });

  it("an earlier run ending leaves the newer one stoppable", () => {
    const first = startRun("tab-2");
    const second = startRun("tab-2");
    expect(first.signal.aborted).toBe(true);
    endRun("tab-2", first);
    stopRuns("tab-2");
    expect(second.signal.aborted).toBe(true);
  });

  it("a replaced run's stop leaves the newer run running", async () => {
    const tabId = useEditorStore.getState().addTab("Query", "");
    const run = executeQuery();
    const tab = () => useEditorStore.getState().tabs.find((t) => t.id === tabId)!;

    const first = run(tabId, "SELECT 1");
    const second = run(tabId, "SELECT 2");
    await first;
    expect(tab().isRunning).toBe(true);

    pending[pending.length - 1]({ columns: ["a"], rows: [[2]], time: 1 });
    await second;
    expect(tab().isRunning).toBe(false);
    expect(tab().result).toMatchObject({ rows: [[2]] });
  });
});
