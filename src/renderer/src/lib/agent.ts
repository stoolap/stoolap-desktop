/**
 * SQL agent: runs in Rust (src-tauri/src/agent), through the local
 * Claude Code or Codex, or the Claude or OpenAI API; this is the renderer's
 * side of its commands and events.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AgentModel {
  id: string;
  name: string;
}

export interface EditorContext {
  /** The tab the user is looking at */
  tabTitle: string;
  sql: string;
  selection?: string;
  lastError?: string;
  /** The tab the agent writes into */
  targetTabId: string;
  targetTabTitle: string;
}

export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool"; id: string; name: string; summary: string; isError: boolean }
  /** write_query's SQL so far, while it streams in */
  | { kind: "draft"; tabId: string; sql: string }
  /** write_query's complete SQL; answer with writeResult */
  | {
      kind: "write";
      requestId: string;
      /** The database the request is about: it runs only there */
      connId: string;
      tabId: string;
      sql: string;
      explanation: string;
      /** The user lets the agent run SQL that can change data */
      allowWrites: boolean;
    }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

/** The models a backend offers; the first is the default. */
export function listModels(backend: Backend): Promise<AgentModel[]> {
  return invoke("agent_models", { backend });
}

/**
 * Claude Code, the Claude API with a browser sign-in (Anthropic's ant CLI)
 * or a key, Codex signed in to ChatGPT, or the OpenAI API with a key
 */
export type Backend = "claude-code" | "console" | "api" | "codex" | "openai";

/** Whose API keys the app keeps */
export type KeyProvider = "anthropic" | "openai";

export function isOpenAi(backend: Backend): boolean {
  return backend === "codex" || backend === "openai";
}

export interface Backends {
  /** The local Claude Code install, if one was found */
  claudeCode: { path: string; version: string | null } | null;
  hasApiKey: boolean;
  hasOpenaiKey: boolean;
  /** The local Codex install, and whether the app's own Codex home is signed in to ChatGPT */
  codex: { path: string; version: string | null; signedIn: boolean } | null;
  /** Browser sign-in (null where unavailable): whether its tool is set up, and signed in */
  console: { installed: boolean; signedIn: boolean } | null;
}

export function backends(): Promise<Backends> {
  return invoke("agent_backends");
}

/** One-time setup of browser sign-in (downloads Anthropic's ant CLI). */
export function consoleInstall(): Promise<void> {
  return invoke("agent_console_install");
}

/** Sign in with the browser; resolves once the user approves. */
export function consoleLogin(): Promise<void> {
  return invoke("agent_console_login");
}

export function consoleLogout(): Promise<void> {
  return invoke("agent_console_logout");
}

/** Sign Codex in to ChatGPT in the browser; resolves once the user approves. */
export function codexLogin(): Promise<void> {
  return invoke("agent_codex_login");
}

export function codexLogout(): Promise<void> {
  return invoke("agent_codex_logout");
}

/** Open an http(s) link from a reply in the browser. */
export function openLink(url: string): Promise<void> {
  return invoke("agent_open_link", { url });
}

/** Saved in the OS credential store; the renderer never reads it back. */
export function setKey(provider: KeyProvider, key: string): Promise<void> {
  return invoke("agent_set_key", { provider, key });
}

export function deleteKey(provider: KeyProvider): Promise<void> {
  return invoke("agent_delete_key", { provider });
}

export function send(args: {
  conversationId: string;
  connId: string;
  connectionName: string;
  backend: Backend;
  model: string;
  allowWrites: boolean;
  text: string;
  context: EditorContext;
  /** The conversation so far, used when the backend no longer holds it (after a restart) */
  earlier?: string;
}): Promise<void> {
  return invoke("agent_send", args);
}

/** What running a write_query in the tab gave; the Rust side decides what the model sees. */
/** One statement's result, with how long it took (ms) */
export type StatementOutcome = (
  | { columns: string[]; rows: unknown[][]; rowCount: number }
  | { changes: number }
  | { ddl: string }
) & { time: number };

export type WriteOutcome =
  | { ran: false; reason?: string }
  | { ran: true; error: string }
  | ({ ran: true } & StatementOutcome)
  | { ran: true; statements: StatementOutcome[]; time: number };

export function writeResult(requestId: string, outcome: WriteOutcome): Promise<void> {
  return invoke("agent_write_result", { requestId, outcome });
}

export function cancel(conversationId: string): Promise<void> {
  return invoke("agent_cancel", { conversationId });
}

export function reset(conversationId: string): Promise<void> {
  return invoke("agent_reset", { conversationId });
}

/** Subscribe to agent progress; same disposal guard as native.subscribe. */
export function onEvent(
  handler: (conversationId: string, event: AgentEvent) => void,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<{ conversationId: string; event: AgentEvent }>("agent:event", (e) =>
    handler(e.payload.conversationId, e.payload.event),
  ).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
