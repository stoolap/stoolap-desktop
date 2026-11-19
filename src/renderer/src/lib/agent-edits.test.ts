import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeResult = vi.fn(async () => {});
vi.mock("@/lib/agent", () => ({ writeResult }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const ran: { tabId: string; sql: string; connId?: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  ran.length = 0;
  writeResult.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal("window", {
    dispatchEvent: (e: CustomEvent) => {
      ran.push(e.detail);
      e.detail.handled = true;
      e.detail.done({ columns: ["n"], rows: [[1]], time: 1 });
      return true;
    },
  });
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(
        public type: string,
        public init: { detail: unknown },
      ) {}
      get detail() {
        return this.init.detail;
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { applyWrite, startWrites, stopWrites } = await import("./agent-edits");
const { useAgentStore } = await import("@/stores/agent-store");
const { useConnectionStore } = await import("@/stores/connection-store");
const { useEditorStore } = await import("@/stores/editor-store");

function setup(allow: boolean) {
  const tabId = useEditorStore.getState().addTab("Query", "");
  useConnectionStore.setState({ activeId: "conn-a" });
  const chat = useAgentStore.getState().newChat("/db/a");
  useAgentStore.getState().setWriteAccess("/db/a", allow);
  startWrites(chat);
  return { chat, tabId };
}

const write = (tabId: string, sql: string) => ({
  requestId: "r1",
  connId: "conn-a",
  tabId,
  sql,
  explanation: "",
  allowWrites: true,
});

describe("applyWrite", () => {
  it("runs a write on the request's database when allowed", async () => {
    const { chat, tabId } = setup(true);
    const done = applyWrite(chat, write(tabId, "DELETE FROM t"));
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([expect.objectContaining({ sql: "DELETE FROM t", connId: "conn-a" })]);
    expect(writeResult).toHaveBeenCalledWith("r1", expect.objectContaining({ ran: true }));
  });

  it("doesn't run a write the user stopped while it waited", async () => {
    const { chat, tabId } = setup(true);
    const done = applyWrite(chat, write(tabId, "DELETE FROM t"));
    stopWrites(chat);
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
    expect(writeResult).toHaveBeenCalledWith("r1", { ran: false, reason: "the user stopped the request" });
    const item = useAgentStore.getState().conversations[chat].items.at(-1);
    expect(item).toMatchObject({ kind: "proposal", autoRan: false });
  });

  it("doesn't run a write whose event arrives after Stop", async () => {
    const { chat, tabId } = setup(true);
    stopWrites(chat);
    const done = applyWrite(chat, write(tabId, "DELETE FROM t"));
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
  });

  it("doesn't run a write stopped in the frame before it would start", async () => {
    const { chat, tabId } = setup(true);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) =>
      setTimeout(() => {
        stopWrites(chat);
        cb();
      }, 0),
    );
    const done = applyWrite(chat, write(tabId, "DELETE FROM t"));
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
  });

  it("runs again once the next request starts", async () => {
    const { chat, tabId } = setup(true);
    stopWrites(chat);
    startWrites(chat);
    const done = applyWrite(chat, write(tabId, "SELECT 1"));
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toHaveLength(1);
  });

  it("doesn't run a stopped request's write once a new request starts", async () => {
    const { chat, tabId } = setup(true);
    const done = applyWrite(chat, write(tabId, "DELETE FROM t"));
    stopWrites(chat);
    startWrites(chat);
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
  });

  it("doesn't run on another database the user switched to", async () => {
    const { chat, tabId } = setup(true);
    const done = applyWrite(chat, write(tabId, "SELECT 1"));
    useConnectionStore.setState({ activeId: "conn-b" });
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
    expect(writeResult).toHaveBeenCalledWith("r1", expect.objectContaining({ ran: false }));
  });

  it("doesn't run a write once Run writes is turned off", async () => {
    const { chat, tabId } = setup(true);
    const done = applyWrite(chat, write(tabId, "UPDATE t SET a = 1"));
    useAgentStore.getState().setWriteAccess("/db/a", false);
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
  });

  it("doesn't run for a deleted conversation", async () => {
    const { chat, tabId } = setup(true);
    const done = applyWrite(chat, write(tabId, "SELECT 1"));
    useAgentStore.getState().deleteChat(chat);
    await vi.runAllTimersAsync();
    await done;
    expect(ran).toEqual([]);
  });
});
