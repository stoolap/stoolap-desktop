import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { endRun, startRun, stopRuns } = await import("./use-query-execution");

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
});
