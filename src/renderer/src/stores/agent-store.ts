import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentEvent, Backend, ToolDetail } from "@/lib/agent";

export type AgentItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "tool"; name: string; summary: string; isError: boolean; detail?: ToolDetail }
  | {
      id: number;
      kind: "proposal";
      tabId: string;
      /** The tab's SQL before the edit, for Undo */
      before: string;
      sql: string;
      explanation: string;
      /** Written into the tab; false after Undo */
      applied: boolean;
      /** Ran in the tab on its own (a single read-only statement) */
      autoRan: boolean;
    }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "note"; text: string };

export interface Conversation {
  items: AgentItem[];
  running: boolean;
  /** The conversation's own editor tab, in "new tab" mode */
  tabId?: string;
  /** The database it is about (path, or id for in-memory) */
  dbKey: string;
  /** The first request, as the history list shows it */
  title: string;
  updatedAt: number;
}

const EMPTY: Conversation = { items: [], running: false, dbKey: "", title: "", updatedAt: 0 };

/** Kept across launches */
const MAX_CONVERSATIONS = 50;
const MAX_PROMPTS = 100;

export type NewProposal = Omit<Extract<AgentItem, { kind: "proposal" }>, "id">;

interface AgentState {
  open: boolean;
  width: number;
  /** Claude model */
  model: string;
  /** OpenAI model (Codex or the OpenAI API); "" takes the backend's default */
  openaiModel: string;
  /** Chosen backend; null picks Claude Code when it is installed */
  backend: Backend | null;
  /** Databases (path, or id for in-memory) where the agent may run SQL that changes data */
  writeAccess: Record<string, boolean>;
  /** Write into a tab of the agent's own, or the tab the user is on */
  target: "new" | "current";
  conversations: Record<string, Conversation>;
  /** Database -> the conversation the panel shows for it */
  activeChat: Record<string, string>;
  /** The user's requests, most recent first, for recalling with the arrow keys */
  promptHistory: string[];
  /** A request made elsewhere in the app, sent once the panel is mounted */
  pendingAsk: string | null;
  ask: (text: string) => void;
  takePendingAsk: () => string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
  setModel: (model: string) => void;
  setOpenaiModel: (model: string) => void;
  setBackend: (backend: Backend | null) => void;
  setWriteAccess: (key: string, allowed: boolean) => void;
  setTarget: (target: "new" | "current") => void;
  setConversationTab: (id: string, tabId: string) => void;
  conversation: (id: string) => Conversation;
  /** Start an empty conversation about a database and show it */
  newChat: (dbKey: string) => string;
  openChat: (dbKey: string, id: string) => void;
  deleteChat: (id: string) => void;
  rememberPrompt: (text: string) => void;
  startRequest: (id: string, text: string) => void;
  failRequest: (id: string, message: string) => void;
  handleEvent: (id: string, event: AgentEvent) => void;
  /** Returns the new item's id */
  addProposal: (id: string, proposal: NewProposal) => number;
  setApplied: (id: string, itemId: number, applied: boolean) => void;
  /** It was going to run but was stopped before it did */
  setNotRun: (id: string, itemId: number) => void;
}

// Unique across launches, since conversations are kept
let nextId = Date.now();

function update(
  s: AgentState,
  id: string,
  fn: (c: Conversation) => Conversation,
): Partial<AgentState> {
  const c = s.conversations[id];
  // A deleted conversation stays deleted, even if its request still reports
  if (!c) return {};
  return { conversations: { ...s.conversations, [id]: fn(c) } };
}

/** Append streamed text to the last item of the same kind, or start one. */
function appendStreamed(items: AgentItem[], kind: "text" | "thinking", delta: string) {
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...items, { id: nextId++, kind, text: delta }];
}

/**
 * The conversations worth keeping: the most recent ones that say something,
 * none still running (a request doesn't survive a restart).
 */
function keptConversations(all: Record<string, Conversation>): Record<string, Conversation> {
  return Object.fromEntries(
    Object.entries(all)
      .filter(([, c]) => c.items.length > 0)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map(([id, c]) => [
        id,
        {
          ...c,
          running: false,
          // Thinking is the bulk and not needed to read a conversation back
          items: c.items.filter((it) => it.kind !== "thinking"),
        },
      ]),
  );
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      open: false,
      width: 380,
      model: "claude-opus-5-5",
      openaiModel: "",
      backend: null,
      writeAccess: {},
      target: "new",
      conversations: {},
      activeChat: {},
      promptHistory: [],
      pendingAsk: null,
      ask: (text) => set({ open: true, pendingAsk: text }),
      takePendingAsk: () => {
        const text = get().pendingAsk;
        if (text !== null) set({ pendingAsk: null });
        return text;
      },
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      setWidth: (width) => set({ width }),
      setModel: (model) => set({ model }),
      setOpenaiModel: (openaiModel) => set({ openaiModel }),
      setBackend: (backend) => set({ backend }),
      setWriteAccess: (key, allowed) =>
        set((s) => ({ writeAccess: { ...s.writeAccess, [key]: allowed } })),
      setTarget: (target) => set({ target }),
      setConversationTab: (id, tabId) => set((s) => update(s, id, (c) => ({ ...c, tabId }))),
      conversation: (id) => get().conversations[id] ?? EMPTY,
      newChat: (dbKey) => {
        const id = crypto.randomUUID();
        set((s) => ({
          conversations: { ...s.conversations, [id]: { ...EMPTY, dbKey, updatedAt: Date.now() } },
          activeChat: { ...s.activeChat, [dbKey]: id },
        }));
        return id;
      },
      openChat: (dbKey, id) => set((s) => ({ activeChat: { ...s.activeChat, [dbKey]: id } })),
      deleteChat: (id) =>
        set((s) => {
          const conversations = { ...s.conversations };
          delete conversations[id];
          const activeChat = Object.fromEntries(Object.entries(s.activeChat).filter(([, c]) => c !== id));
          return { conversations, activeChat };
        }),
      rememberPrompt: (text) =>
        set((s) => ({
          promptHistory: [text, ...s.promptHistory.filter((p) => p !== text)].slice(0, MAX_PROMPTS),
        })),
      startRequest: (id, text) =>
        set((s) =>
          update(s, id, (c) => ({
            ...c,
            items: [...c.items, { id: nextId++, kind: "user", text }],
            running: true,
            title: c.title || text,
            updatedAt: Date.now(),
          })),
        ),
      failRequest: (id, message) =>
        set((s) =>
          update(s, id, (c) => ({
            ...c,
            running: false,
            items: [...c.items, { id: nextId++, kind: "error", text: message }],
          })),
        ),
      handleEvent: (id, event) =>
        set((s) =>
          update(s, id, (c) => {
            switch (event.kind) {
              case "text":
              case "thinking":
                return { ...c, items: appendStreamed(c.items, event.kind, event.delta) };
              case "tool":
                return {
                  ...c,
                  items: [
                    ...c.items,
                    {
                      id: nextId++,
                      kind: "tool",
                      name: event.name,
                      summary: event.summary,
                      isError: event.isError,
                      detail: event.detail,
                    },
                  ],
                };
              case "draft":
              case "write":
                // Handled in the editor by AgentDock (lib/agent-edits.ts)
                return c;
              case "done":
                return { ...c, running: false, updatedAt: Date.now() };
              case "cancelled":
                return {
                  ...c,
                  running: false,
                  items: [...c.items, { id: nextId++, kind: "note", text: "Stopped." }],
                };
              case "error":
                return {
                  ...c,
                  running: false,
                  items: [...c.items, { id: nextId++, kind: "error", text: event.message }],
                };
            }
          }),
        ),
      addProposal: (id, proposal) => {
        const itemId = nextId++;
        set((s) =>
          update(s, id, (c) => ({
            ...c,
            items: [...c.items, { id: itemId, ...proposal }],
          })),
        );
        return itemId;
      },
      setNotRun: (id, itemId) =>
        set((s) =>
          update(s, id, (c) => ({
            ...c,
            items: c.items.map((it) =>
              it.id === itemId && it.kind === "proposal" ? { ...it, autoRan: false } : it,
            ),
          })),
        ),
      setApplied: (id, itemId, applied) =>
        set((s) =>
          update(s, id, (c) => ({
            ...c,
            items: c.items.map((it) =>
              it.id === itemId && it.kind === "proposal" ? { ...it, applied } : it,
            ),
          })),
        ),
    }),
    {
      // Named when it was "the assistant"; renaming it would lose saved chats
      name: "stoolap-assistant",
      // Conversations used to be per connection and not kept: start fresh
      version: 1,
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        delete p.conversations;
        return p as unknown as AgentState;
      },
      partialize: (s) => ({
        conversations: keptConversations(s.conversations),
        activeChat: s.activeChat,
        promptHistory: s.promptHistory,
        open: s.open,
        width: s.width,
        model: s.model,
        openaiModel: s.openaiModel,
        backend: s.backend,
        writeAccess: s.writeAccess,
        target: s.target,
      }),
    },
  ),
);
