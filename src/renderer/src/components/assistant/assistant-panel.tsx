import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  History,
  KeyRound,
  LogIn,
  UserRound,
  Play,
  Redo2,
  Terminal,
  Undo2,
  MoreHorizontal,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as assistant from "@/lib/assistant";
import { isOpenAi, type AssistantModel, type Backend, type Backends, type KeyProvider } from "@/lib/assistant";
import { getEditorSelection } from "@/lib/editor-registry";
import { foldUnchanged, lineDiff } from "@/lib/line-diff";
import { runInTab } from "@/lib/assistant-edits";
import { cn, errorMessage } from "@/lib/utils";
import { useAssistantStore, type AssistantItem } from "@/stores/assistant-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";
import { useModKey } from "@/hooks/use-mod-key";
import { useEditorSchema } from "@/hooks/use-schema";
import { contextPrompts } from "@/lib/assistant-prompts";
import { MessageText } from "./message-text";
import { Composer, type ComposerHandle } from "./composer";

/** "5 min ago", "yesterday", or the date */
function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return h < 48 ? "yesterday" : new Date(ms).toLocaleDateString();
}

/** What was said so far, for a conversation the backend no longer holds */
function transcript(items: AssistantItem[]): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === "user") lines.push(`User: ${it.text}`);
    else if (it.kind === "text") lines.push(`Assistant: ${it.text}`);
    else if (it.kind === "proposal") lines.push(`Assistant wrote into the tab:\n${it.sql}`);
  }
  // The latest part is what matters; keep it to a reasonable size
  const text = lines.map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}…` : l)).join("\n\n");
  return text.length > 12000 ? `…${text.slice(-12000)}` : text;
}

export function AssistantPanel() {
  const mod = useModKey();
  const [models, setModels] = useState<AssistantModel[]>([]);
  const [info, setInfo] = useState<Backends | null>(null);
  const [editingKey, setEditingKey] = useState<KeyProvider | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerHandle>(null);

  const setOpen = useAssistantStore((s) => s.setOpen);
  const claudeModel = useAssistantStore((s) => s.model);
  const setClaudeModel = useAssistantStore((s) => s.setModel);
  const openaiModel = useAssistantStore((s) => s.openaiModel);
  const setOpenaiModel = useAssistantStore((s) => s.setOpenaiModel);
  const writeAccess = useAssistantStore((s) => s.writeAccess);
  const setWriteAccess = useAssistantStore((s) => s.setWriteAccess);
  const target = useAssistantStore((s) => s.target);
  const setTarget = useAssistantStore((s) => s.setTarget);
  const conversations = useAssistantStore((s) => s.conversations);
  const activeChat = useAssistantStore((s) => s.activeChat);
  const promptHistory = useAssistantStore((s) => s.promptHistory);
  const schema = useEditorSchema();
  const chosenBackend = useAssistantStore((s) => s.backend);
  const setBackend = useAssistantStore((s) => s.setBackend);
  // Unless the user picked one: Claude Code, else a browser sign-in, else
  // ChatGPT through Codex, else a key
  const backend: Backend =
    chosenBackend ??
    (info?.claudeCode
      ? "claude-code"
      : info?.console?.signedIn
        ? "console"
        : info?.codex?.signedIn
          ? "codex"
          : "api");
  const needsSetup =
    editingKey !== null ||
    (info !== null &&
      ((backend === "api" && !info.hasApiKey) ||
        (backend === "claude-code" && !info.claudeCode) ||
        (backend === "console" && !info.console?.signedIn) ||
        (backend === "codex" && !info.codex?.signedIn) ||
        (backend === "openai" && !info.hasOpenaiKey)));
  // Claude's models and OpenAI's are kept apart; an OpenAI model the
  // account doesn't offer falls back to its default
  const openai = isOpenAi(backend);
  const model = openai
    ? (models.find((m) => m.id === openaiModel)?.id ?? models[0]?.id ?? "")
    : claudeModel;
  const setModel = openai ? setOpenaiModel : setClaudeModel;

  const activeId = useConnectionStore((s) => s.activeId);
  const connections = useConnectionStore((s) => s.connections);
  const conn = connections.find((c) => c.id === activeId);
  // Row access follows the database (its path), not the session's connection id
  const accessKey = conn ? (conn.type === "memory" ? conn.id : conn.path) : "";
  const allowWrites = !!writeAccess[accessKey];

  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);

  // The conversation shown for this database, and its others for the history list
  const chatId = accessKey ? activeChat[accessKey] : undefined;
  const conversation = (chatId && conversations[chatId]) || null;
  const items = conversation?.items ?? [];
  const running = conversation?.running ?? false;
  const pastChats = useMemo(
    () =>
      Object.entries(conversations)
        .filter(([, c]) => c.dbKey === accessKey && c.items.length > 0)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt),
    [conversations, accessKey],
  );

  const lookingTab = activeTab?.mode === "query" ? activeTab : null;
  const lookingError =
    lookingTab?.result && "error" in lookingTab.result && lookingTab.result.error ? lookingTab.result.error : undefined;
  const prompts = useMemo(
    () =>
      contextPrompts(
        lookingTab ? { sql: lookingTab.sql, lastError: lookingError, hasSelection: !!getEditorSelection() } : null,
        Object.keys(schema ?? {}),
      ),
    [lookingTab, lookingError, schema],
  );

  const refreshBackends = () =>
    assistant
      .backends()
      .then(setInfo)
      .catch(() =>
        setInfo({ claudeCode: null, hasApiKey: false, hasOpenaiKey: false, codex: null, console: null }),
      );

  useEffect(() => {
    refreshBackends();
  }, []);

  // The model list follows the backend (OpenAI's comes from the account)
  const ready = info !== null && !needsSetup;
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    setModels([]);
    assistant
      .listModels(backend)
      .then((m) => !stale && setModels(m))
      .catch((e) => {
        if (stale) return;
        setModels([]);
        toast.error("Could not load the models", { description: errorMessage(e) });
      });
    return () => {
      stale = true;
    };
  }, [backend, ready]);

  // Follow the conversation as it streams
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !conn || !activeId || !accessKey || running || !model) return;
    const looking = activeTab?.mode === "query" ? activeTab : null;
    if (target === "current" && !looking) {
      toast.error("Open a query tab for the assistant to work in, or let it use a new tab.");
      return;
    }
    const lastError =
      looking?.result && "error" in looking.result && looking.result.error
        ? looking.result.error
        : undefined;

    const store = useAssistantStore.getState();
    const id = chatId && store.conversations[chatId] ? chatId : store.newChat(accessKey);
    const earlier = transcript(store.conversations[id]?.items ?? []);

    // Where the assistant writes: the tab the user is on, or the
    // conversation's own tab (made on first use), which comes to the front
    const editor = useEditorStore.getState();
    let targetTab = looking;
    if (target === "new") {
      const own = editor.tabs.find((t) => t.id === conversation?.tabId && t.mode === "query");
      if (own) {
        targetTab = own;
        editor.setActiveTab(own.id);
      } else {
        const tabId = editor.addTab("Assistant", "");
        store.setConversationTab(id, tabId);
        targetTab = useEditorStore.getState().tabs.find((t) => t.id === tabId) ?? null;
      }
    }
    if (!targetTab) return;
    store.startRequest(id, trimmed);
    store.rememberPrompt(trimmed);
    setDraft("");
    try {
      await assistant.send({
        conversationId: id,
        connId: activeId,
        connectionName: conn.name,
        backend,
        model,
        allowWrites,
        text: trimmed,
        context: {
          tabTitle: looking?.title ?? "",
          sql: looking?.sql ?? "",
          selection: (looking && getEditorSelection()) || undefined,
          lastError,
          targetTabId: targetTab.id,
          targetTabTitle: targetTab.title,
        },
        earlier: earlier || undefined,
      });
    } catch (e) {
      store.failRequest(id, errorMessage(e));
    }
  };

  // Requests made elsewhere in the app (useAssistantStore().ask)
  const pendingAsk = useAssistantStore((s) => s.pendingAsk);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (pendingAsk === null) return;
    const text = useAssistantStore.getState().takePendingAsk();
    if (text) askRef.current(text);
  }, [pendingAsk]);

  /** Leave the shown conversation: the backend lets go of it unless it is still working */
  const leave = () => {
    if (chatId && !running) assistant.reset(chatId).catch(() => {});
  };
  const newChat = () => {
    if (!accessKey) return;
    if (items.length > 0) {
      leave();
      useAssistantStore.getState().newChat(accessKey);
    }
    inputRef.current?.focus();
  };
  const openChat = (id: string) => {
    if (!accessKey || id === chatId) return;
    leave();
    useAssistantStore.getState().openChat(accessKey, id);
  };
  const deleteChat = () => {
    if (!chatId) return;
    assistant.cancel(chatId).catch(() => {});
    assistant.reset(chatId).catch(() => {});
    useAssistantStore.getState().deleteChat(chatId);
  };

  const signOut = async (logout: () => Promise<void>) => {
    try {
      await logout();
      await refreshBackends();
    } catch (e) {
      toast.error("Could not sign out", { description: errorMessage(e) });
    }
  };

  const removeKey = async (provider: KeyProvider) => {
    try {
      await assistant.deleteKey(provider);
      await refreshBackends();
    } catch (e) {
      toast.error("Could not remove the key", { description: errorMessage(e) });
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/40 pl-3 pr-1">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Assistant</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={newChat} aria-label="New conversation" disabled={!accessKey}>
              <SquarePen className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New conversation</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Earlier conversations" disabled={!accessKey}>
                  <History className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Earlier conversations</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
            {pastChats.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No conversations about this database yet.</div>
            ) : (
              pastChats.map(([id, c]) => (
                <DropdownMenuItem key={id} onSelect={() => openChat(id)} className="flex items-start gap-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs">{c.title || "Untitled"}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {c.running ? "Working…" : ago(c.updatedAt)}
                    </span>
                  </span>
                  {id === chatId && <Check className="mt-0.5 h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))
            )}
            {conversation && items.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={deleteChat} className="text-xs">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete this conversation
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Assistant settings">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setBackend("claude-code")} disabled={!info?.claudeCode}>
              <Terminal className="h-3.5 w-3.5" />
              <span className="flex-1">Use Claude Code</span>
              {backend === "claude-code" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackend("console")}>
              <UserRound className="h-3.5 w-3.5" />
              <span className="flex-1">Use my Anthropic account</span>
              {backend === "console" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackend("api")}>
              <KeyRound className="h-3.5 w-3.5" />
              <span className="flex-1">Use an Anthropic API key</span>
              {backend === "api" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setBackend("codex")} disabled={!info?.codex}>
              <Terminal className="h-3.5 w-3.5" />
              <span className="flex-1">Use ChatGPT (Codex)</span>
              {backend === "codex" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackend("openai")}>
              <KeyRound className="h-3.5 w-3.5" />
              <span className="flex-1">Use an OpenAI API key</span>
              {backend === "openai" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setEditingKey(openai ? "openai" : "anthropic")}>
              Add or change an API key…
            </DropdownMenuItem>
            {info?.hasApiKey && (
              <DropdownMenuItem onSelect={() => removeKey("anthropic")}>Remove Anthropic API key</DropdownMenuItem>
            )}
            {info?.hasOpenaiKey && (
              <DropdownMenuItem onSelect={() => removeKey("openai")}>Remove OpenAI API key</DropdownMenuItem>
            )}
            {info?.console?.signedIn && (
              <DropdownMenuItem onSelect={() => signOut(assistant.consoleLogout)}>
                Sign out of Anthropic account
              </DropdownMenuItem>
            )}
            {info?.codex?.signedIn && (
              <DropdownMenuItem onSelect={() => signOut(assistant.codexLogout)}>Sign out of ChatGPT</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(false)} aria-label="Close assistant">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {needsSetup && info ? (
        <Setup
          info={info}
          keyProvider={editingKey ?? (openai ? "openai" : "anthropic")}
          onUse={(b) => {
            setEditingKey(null);
            setBackend(b);
            refreshBackends();
          }}
          onRecheck={refreshBackends}
          onCancel={editingKey ? () => setEditingKey(null) : undefined}
        />
      ) : !conn ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Open a database to use the assistant.
        </div>
      ) : (
        <>
          {/* Conversation: selectable and copyable, unlike the app's chrome */}
          <div ref={scrollRef} className="allow-select flex-1 overflow-y-auto px-3 py-3">
            {items.length === 0 ? (
              <div className="flex flex-col gap-3 pt-6 text-sm">
                <p className="text-muted-foreground">
                  Ask about the SQL in <span className="text-foreground">{activeTab?.title ?? "your tab"}</span>, or
                  for a new query on <span className="text-foreground">{conn.name}</span>. The assistant writes and runs
                  its SQL in {target === "new" ? "a new tab" : "this tab"}; reads run right away, changes to data only
                  when you allow writes.
                </p>
                <div className="flex flex-col gap-1">
                  {prompts.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => ask(e)}
                      className="rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {items.map((item) => (
                  <ItemView key={item.id} item={item} conversationId={chatId!} />
                ))}
                {running && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    Working…
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-border/40 p-2">
            <div className="rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
              <Composer
                ref={inputRef}
                value={draft}
                onChange={setDraft}
                onSubmit={() => ask(draft)}
                hints={{ history: promptHistory, prompts, schema }}
                placeholder="Ask about this query… (@ for tables)"
              />
              <div className="flex items-center gap-1 px-1.5 pb-1.5">
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger aria-label="Model" className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" side="top" align="start">
                    {models.length === 0 && (
                      <SelectItem value="__loading" disabled className="text-xs">
                        Loading…
                      </SelectItem>
                    )}
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        {m.name.replace(/^Claude /, "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={target} onValueChange={(v) => setTarget(v as "new" | "current")}>
                  <SelectTrigger
                    aria-label="Where the assistant writes"
                    title="Where the assistant writes and runs its SQL"
                    className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" side="top" align="start">
                    <SelectItem value="new" className="text-xs">New tab</SelectItem>
                    <SelectItem value="current" className="text-xs">This tab</SelectItem>
                  </SelectContent>
                </Select>
                <label
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-1.5 text-xs",
                    allowWrites ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
                  )}
                  title="Let the assistant run SQL that changes this database (INSERT, UPDATE, DELETE, DDL) without asking. Reads always run."
                >
                  <Switch
                    checked={allowWrites}
                    onCheckedChange={(v) => setWriteAccess(accessKey, v)}
                    className="scale-75"
                    aria-label="Allow the assistant to run writes"
                  />
                  Run writes
                </label>
                <div className="flex-1" />
                {running ? (
                  <Button size="icon" variant="secondary" className="h-6 w-6" onClick={() => assistant.cancel(chatId!)} aria-label="Stop">
                    <Square className="h-3 w-3" />
                  </Button>
                ) : (
                  <Button size="icon" className="h-6 w-6" onClick={() => ask(draft)} disabled={!draft.trim() || !model} aria-label="Send">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1 px-1 text-[11px] text-muted-foreground/70">
              {backend === "claude-code"
                ? `Claude Code${info?.claudeCode?.version ? ` ${info.claudeCode.version.split(" ")[0]}` : ""}`
                : backend === "console"
                  ? "Anthropic account"
                  : backend === "codex"
                    ? "ChatGPT via Codex"
                    : backend === "openai"
                      ? "OpenAI API key"
                      : "Anthropic API key"}{" "}
              · {mod}L toggles the panel · ↑ earlier requests · Tab completes
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Setup({
  info,
  keyProvider,
  onUse,
  onRecheck,
  onCancel,
}: {
  info: Backends;
  /** Whose key the key form starts on */
  keyProvider: KeyProvider;
  onUse: (backend: Backend) => void;
  onRecheck: () => void;
  onCancel?: () => void;
}) {
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<KeyProvider>(keyProvider);
  const [codexSigningIn, setCodexSigningIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signInStep, setSignInStep] = useState<"idle" | "setup" | "approve">("idle");
  const [showKey, setShowKey] = useState(!!onCancel);
  const save = async () => {
    setSaving(true);
    try {
      await assistant.setKey(provider, key);
      setKey("");
      onUse(provider === "openai" ? "openai" : "api");
    } catch (e) {
      toast.error("Could not save the key", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  const signIn = async () => {
    try {
      // First time only: fetch the sign-in tool
      if (!info.console?.installed) {
        setSignInStep("setup");
        await assistant.consoleInstall();
      }
      setSignInStep("approve");
      await assistant.consoleLogin();
      onUse("console");
    } catch (e) {
      toast.error("Sign-in did not finish", { description: errorMessage(e) });
    } finally {
      setSignInStep("idle");
    }
  };
  const codexSignIn = async () => {
    setCodexSigningIn(true);
    try {
      await assistant.codexLogin();
      onUse("codex");
    } catch (e) {
      toast.error("Sign-in did not finish", { description: errorMessage(e) });
    } finally {
      setCodexSigningIn(false);
    }
  };
  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-4 text-sm">
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <Terminal className="h-3.5 w-3.5" /> Claude Code
          <span className="text-xs font-normal text-muted-foreground">recommended</span>
        </h3>
        {info.claudeCode ? (
          <>
            <p className="text-muted-foreground">
              Found {info.claudeCode.version ?? "Claude Code"}. The assistant runs through it with your Claude
              sign-in and plan, and only gets this app's database tools.
            </p>
            <Button size="sm" onClick={() => onUse("claude-code")}>
              Use Claude Code
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">
            Install Claude Code (claude.ai/code) and sign in once with <span className="font-data text-xs">claude</span>{" "}
            in a terminal. The assistant then uses your Claude plan.
          </p>
        )}
      </section>

      {info.console && (
        <section className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <h3 className="flex items-center gap-1.5 font-medium">
            <UserRound className="h-3.5 w-3.5" /> Anthropic account
          </h3>
          <p className="text-muted-foreground">
            Sign in with your browser to call the Claude API, billed to your Anthropic Console organization. No key
            to copy.
          </p>
          {info.console?.signedIn ? (
            <Button size="sm" variant="outline" onClick={() => onUse("console")}>
              Use my Anthropic account
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={signIn} disabled={signInStep !== "idle"}>
              <LogIn className="h-3.5 w-3.5" />
              {signInStep === "setup"
                ? "Setting up sign-in…"
                : signInStep === "approve"
                  ? "Waiting for you to approve in the browser…"
                  : "Sign in with browser"}
            </Button>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <h3 className="flex items-center gap-1.5 font-medium">
          <Terminal className="h-3.5 w-3.5" /> ChatGPT
        </h3>
        {info.codex ? (
          <>
            <p className="text-muted-foreground">
              Through {info.codex.version ?? "Codex"}, with your ChatGPT plan. The app signs Codex in on its own, so
              your Codex settings and plugins stay out, and it only gets this app&apos;s database tools.
            </p>
            {info.codex.signedIn ? (
              <Button size="sm" variant="outline" onClick={() => onUse("codex")}>
                Use ChatGPT
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={codexSignIn} disabled={codexSigningIn}>
                <LogIn className="h-3.5 w-3.5" />
                {codexSigningIn ? "Waiting for you to approve in the browser…" : "Sign in with ChatGPT"}
              </Button>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            Install Codex (developers.openai.com/codex) to use your ChatGPT plan here.
          </p>
        )}
      </section>

      {!info.claudeCode || !info.codex ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={onRecheck}>
          Check again for Claude Code and Codex
        </Button>
      ) : null}

      {showKey ? (
        <form
          className="flex flex-col gap-2 border-t border-border/60 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3 className="flex items-center gap-1.5 font-medium">
            <KeyRound className="h-3.5 w-3.5" /> API key
          </h3>
          <div className="flex gap-1" role="radiogroup" aria-label="Whose API key">
            {(["anthropic", "openai"] as const).map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={provider === p ? "secondary" : "ghost"}
                className="h-7 px-2.5 text-xs"
                role="radio"
                aria-checked={provider === p}
                onClick={() => setProvider(p)}
              >
                {p === "anthropic" ? "Anthropic" : "OpenAI"}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">
            A key from {provider === "anthropic" ? "console.anthropic.com" : "platform.openai.com"}, kept in your
            system&apos;s credential store and only sent to {provider === "anthropic" ? "Anthropic" : "OpenAI"}.
          </p>
          <Input
            type="password"
            autoComplete="off"
            placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={provider === "anthropic" ? "Anthropic API key" : "OpenAI API key"}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="outline" className="flex-1" disabled={!key.trim() || saving}>
              {saving ? "Saving…" : "Save key and use it"}
            </Button>
            {onCancel && (
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowKey(true)}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Use an API key instead
        </button>
      )}
    </div>
  );
}

function ItemView({ item, conversationId }: { item: AssistantItem; conversationId: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="self-end max-w-[90%] whitespace-pre-wrap rounded-lg bg-accent px-3 py-2 text-sm">
          {item.text}
        </div>
      );
    case "text":
      return <MessageText text={item.text} />;
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return (
        <div className={cn("flex items-start gap-1.5 text-xs", item.isError ? "text-destructive" : "text-muted-foreground")}>
          <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{item.summary}</span>
        </div>
      );
    case "proposal":
      return <Proposal item={item} conversationId={conversationId} />;
    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{item.text}</span>
        </div>
      );
    case "note":
      return <div className="text-xs text-muted-foreground">{item.text}</div>;
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        Thinking
      </button>
      {open && <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2">{text}</p>}
    </div>
  );
}

function Proposal({
  item,
  conversationId,
}: {
  item: Extract<AssistantItem, { kind: "proposal" }>;
  conversationId: string;
}) {
  const tab = useEditorStore((s) => s.tabs.find((t) => t.id === item.tabId));
  const diff = useMemo(() => {
    // Written into an empty tab: it is all new
    if (!item.before.trim()) {
      return item.sql.split("\n").map((text) => ({ type: "add" as const, text }));
    }
    const lines = lineDiff(item.before, item.sql);
    // Nothing kept: show the new SQL rather than a wall of struck-out lines
    const removed = lines.filter((l) => l.type === "remove" && l.text.trim()).length;
    if (removed > 0 && !lines.some((l) => l.type === "same" && l.text.trim())) {
      return [
        { type: "skip" as const, count: removed, replaced: true },
        ...lines.filter((l) => l.type === "add"),
      ];
    }
    return foldUnchanged(lines);
  }, [item.before, item.sql]);
  // Edited by hand since: Undo would throw those edits away too
  const editedSince = !!tab && item.applied && tab.sql !== item.sql;

  const setApplied = (applied: boolean) => {
    if (!tab) return;
    const editor = useEditorStore.getState();
    editor.updateTabSql(tab.id, applied ? item.sql : item.before);
    editor.setActiveTab(tab.id);
    useAssistantStore.getState().setApplied(conversationId, item.id, applied);
  };

  // This block's SQL: in its tab if the tab still holds it, else in a new
  // tab, so a later edit or query in that tab is neither run nor lost
  const run = () => {
    const editor = useEditorStore.getState();
    const id = tab && tab.sql === item.sql ? tab.id : editor.addTab("Assistant", item.sql);
    runInTab(id, item.sql);
  };

  const copy = () => {
    navigator.clipboard.writeText(item.sql).then(
      () => toast.success("SQL copied"),
      () => toast.error("Could not copy"),
    );
  };

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-xs">
        <SquarePen className="h-3 w-3 text-primary" />
        <span className="flex-1 truncate">
          {item.applied ? "Edited" : "Undone in"} <span className="font-medium">{tab?.title ?? "a closed tab"}</span>
          {item.applied && item.autoRan && <span className="text-muted-foreground"> · ran it</span>}
        </span>
      </div>
      {item.explanation && (
        <p className="border-b border-border/60 px-2.5 py-2 text-xs text-muted-foreground">{item.explanation}</p>
      )}
      <pre className="font-data max-h-56 overflow-auto py-1 text-xs leading-5">
        {diff.map((line, i) =>
          line.type === "skip" ? (
            <div key={i} className="select-none px-2.5 text-muted-foreground/60">
              {"replaced" in line
                ? `Replaced ${line.count} line${line.count === 1 ? "" : "s"} with:`
                : `⋯ ${line.count} unchanged line${line.count === 1 ? "" : "s"}`}
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "px-2.5",
                line.type === "add" && "bg-green-500/15 text-green-700 dark:text-green-400",
                line.type === "remove" && "bg-red-500/15 text-red-700 line-through decoration-red-500/40 dark:text-red-400",
              )}
            >
              <span className="mr-2 select-none opacity-50">
                {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
              </span>
              {line.text || " "}
            </div>
          ),
        )}
      </pre>
      <div className="flex items-center gap-1 border-t border-border/60 px-1.5 py-1">
        {tab && item.applied && (
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            variant={item.autoRan ? "ghost" : "default"}
            onClick={run}
            title={item.autoRan ? "Run it again" : "Run it in the tab; this SQL may change data"}
          >
            <Play className="h-3 w-3" /> {item.autoRan ? "Run again" : "Run"}
          </Button>
        )}
        {tab &&
          (item.applied ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setApplied(false)}>
              <Undo2 className="h-3 w-3" /> Undo
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setApplied(true)}>
              <Redo2 className="h-3 w-3" /> Apply again
            </Button>
          ))}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={copy}>
          <Copy className="h-3 w-3" /> Copy
        </Button>
        {editedSince && (
          <span className="ml-auto truncate pr-1 text-[11px] text-amber-600 dark:text-amber-400">
            Edited since; Undo drops those edits
          </span>
        )}
      </div>
    </div>
  );
}
