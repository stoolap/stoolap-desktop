/**
 * SQL assistant: runs in Rust (src-tauri/src/assistant), through the local
 * Claude Code or Codex, or the Claude or OpenAI API; this is the renderer's
 * side of its commands and events.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AssistantModel {
  id: string;
  name: string;
}

export interface EditorContext {
  /** The tab the user is looking at */
  tabTitle: string;
  sql: string;
  selection?: string;
  lastError?: string;
  /** The tab the assistant writes into */
  targetTabId: string;
  targetTabTitle: string;
}

export type AssistantEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool"; id: string; name: string; summary: string; isError: boolean }
  /** write_query's SQL so far, while it streams in */
  | { kind: "draft"; tabId: string; sql: string }
  /** write_query's complete SQL; answer with writeResult */
  | {
      kind: "write";
      requestId: string;
      tabId: string;
      sql: string;
      explanation: string;
      /** The user lets the assistant run SQL that can change data */
      allowWrites: boolean;
    }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

/** The models a backend offers; the first is the default. */
export function listModels(backend: Backend): Promise<AssistantModel[]> {
  return invoke("assistant_models", { backend });
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
  return invoke("assistant_backends");
}

/** One-time setup of browser sign-in (downloads Anthropic's ant CLI). */
export function consoleInstall(): Promise<void> {
  return invoke("assistant_console_install");
}

/** Sign in with the browser; resolves once the user approves. */
export function consoleLogin(): Promise<void> {
  return invoke("assistant_console_login");
}

export function consoleLogout(): Promise<void> {
  return invoke("assistant_console_logout");
}

/** Sign Codex in to ChatGPT in the browser; resolves once the user approves. */
export function codexLogin(): Promise<void> {
  return invoke("assistant_codex_login");
}

export function codexLogout(): Promise<void> {
  return invoke("assistant_codex_logout");
}

/** Saved in the OS credential store; the renderer never reads it back. */
export function setKey(provider: KeyProvider, key: string): Promise<void> {
  return invoke("assistant_set_key", { provider, key });
}

export function deleteKey(provider: KeyProvider): Promise<void> {
  return invoke("assistant_delete_key", { provider });
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
  return invoke("assistant_send", args);
}

/** What running a write_query in the tab gave; the Rust side decides what the model sees. */
export type StatementOutcome =
  | { columns: string[]; rows: unknown[][]; rowCount: number }
  | { changes: number }
  | { ddl: string };

export type WriteOutcome =
  | { ran: false; reason?: string }
  | { ran: true; error: string }
  | ({ ran: true } & StatementOutcome)
  | { ran: true; statements: StatementOutcome[] };

export function writeResult(requestId: string, outcome: WriteOutcome): Promise<void> {
  return invoke("assistant_write_result", { requestId, outcome });
}

export function cancel(conversationId: string): Promise<void> {
  return invoke("assistant_cancel", { conversationId });
}

export function reset(conversationId: string): Promise<void> {
  return invoke("assistant_reset", { conversationId });
}

/** Subscribe to assistant progress; same disposal guard as native.subscribe. */
export function onEvent(
  handler: (conversationId: string, event: AssistantEvent) => void,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<{ conversationId: string; event: AssistantEvent }>("assistant:event", (e) =>
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
