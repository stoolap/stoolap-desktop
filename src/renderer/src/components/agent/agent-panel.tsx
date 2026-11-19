import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import * as agent from "@/lib/agent";
import { isOpenAi, type AgentModel, type Backend, type Backends, type KeyProvider } from "@/lib/agent";
import { getEditorSelection } from "@/lib/editor-registry";
import { foldUnchanged, lineDiff } from "@/lib/line-diff";
import { runInTab, startWrites, stopWrites } from "@/lib/agent-edits";
import { cn, errorMessage } from "@/lib/utils";
import i18n, { locale } from "@/lib/i18n";
import { useAgentStore, type AgentItem } from "@/stores/agent-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";
import { useModKey } from "@/hooks/use-mod-key";
import { useEditorSchema } from "@/hooks/use-schema";
import { contextPrompts } from "@/lib/agent-prompts";
import { highlightSql, MessageText } from "./message-text";
import { resources } from "@/lib/i18n";
import { Composer, type ComposerHandle } from "./composer";
import { Tip } from "@/components/ui/tip";
import { editorSnapshot, localTime, tabError } from "@/lib/agent-context";

/** Titles an agent tab starts with: in every language, and from before the rename */
const AGENT_TAB_TITLES = new Set([
  "Assistant",
  ...Object.values(resources).map((r) => String((r.agent as { tabTitle?: string } | undefined)?.tabTitle ?? "")),
]);

/** "5 min ago", "yesterday", or the date */
function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return i18n.t("agent:ago.justNow");
  if (m < 60) return i18n.t("agent:ago.minutes", { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return i18n.t("agent:ago.hours", { count: h });
  return h < 48 ? i18n.t("agent:ago.yesterday") : new Date(ms).toLocaleDateString(locale());
}

/** What was said so far, for a conversation the backend no longer holds */
function transcript(items: AgentItem[]): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === "user") lines.push(`User: ${it.text}`);
    else if (it.kind === "text") lines.push(`Agent: ${it.text}`);
    else if (it.kind === "proposal") lines.push(`Agent wrote into the tab:\n${it.sql}`);
  }
  // The latest part is what matters; keep it to a reasonable size
  const text = lines.map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}…` : l)).join("\n\n");
  return text.length > 12000 ? `…${text.slice(-12000)}` : text;
}

export function AgentPanel() {
  const { t } = useTranslation("agent");
  const mod = useModKey();
  const [models, setModels] = useState<AgentModel[]>([]);
  const [info, setInfo] = useState<Backends | null>(null);
  const [editingKey, setEditingKey] = useState<KeyProvider | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerHandle>(null);

  const setOpen = useAgentStore((s) => s.setOpen);
  const claudeModel = useAgentStore((s) => s.model);
  const setClaudeModel = useAgentStore((s) => s.setModel);
  const openaiModel = useAgentStore((s) => s.openaiModel);
  const setOpenaiModel = useAgentStore((s) => s.setOpenaiModel);
  const writeAccess = useAgentStore((s) => s.writeAccess);
  const setWriteAccess = useAgentStore((s) => s.setWriteAccess);
  const target = useAgentStore((s) => s.target);
  const setTarget = useAgentStore((s) => s.setTarget);
  const conversations = useAgentStore((s) => s.conversations);
  const activeChat = useAgentStore((s) => s.activeChat);
  const promptHistory = useAgentStore((s) => s.promptHistory);
  const schema = useEditorSchema();
  const chosenBackend = useAgentStore((s) => s.backend);
  const setBackend = useAgentStore((s) => s.setBackend);
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
  const lookingError = tabError(lookingTab);
  const prompts = useMemo(
    () =>
      contextPrompts(
        lookingTab ? { sql: lookingTab.sql, lastError: lookingError, hasSelection: !!getEditorSelection() } : null,
        Object.keys(schema ?? {}),
      ),
    [lookingTab, lookingError, schema],
  );

  const refreshBackends = () =>
    agent
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
    agent
      .listModels(backend)
      .then((m) => !stale && setModels(m))
      .catch((e) => {
        if (stale) return;
        setModels([]);
        toast.error(t("panel.loadModelsFailed"), { description: errorMessage(e) });
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
      toast.error(t("panel.openQueryTab"));
      return;
    }
    const lastError = tabError(looking);

    const store = useAgentStore.getState();
    const id = chatId && store.conversations[chatId] ? chatId : store.newChat(accessKey);
    const earlier = transcript(store.conversations[id]?.items ?? []);

    // Where the agent writes: the tab the user is on, or the
    // conversation's own tab (made on first use), which comes to the front
    const editor = useEditorStore.getState();
    let targetTab = looking;
    if (target === "new") {
      const own = editor.tabs.find((t) => t.id === conversation?.tabId && t.mode === "query");
      if (own) {
        targetTab = own;
        editor.setActiveTab(own.id);
      } else {
        // An empty agent tab left from an earlier conversation is reused
        // rather than piling up another one
        const idle = editor.tabs.find(
          (tab) => tab.mode === "query" && !tab.sql.trim() && AGENT_TAB_TITLES.has(tab.title),
        );
        const tabId = idle?.id ?? editor.addTab(t("tabTitle"), "");
        if (idle) editor.setActiveTab(idle.id);
        store.setConversationTab(id, tabId);
        targetTab = useEditorStore.getState().tabs.find((t) => t.id === tabId) ?? null;
      }
    }
    if (!targetTab) return;
    startWrites(id);
    store.startRequest(id, trimmed);
    store.rememberPrompt(trimmed);
    setDraft("");
    try {
      await agent.send({
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
          storage: conn.type,
          path: conn.type === "file" ? conn.path : undefined,
          openedAt: conn.type === "memory" && conn.createdAt ? localTime(conn.createdAt) : undefined,
          ...editorSnapshot(accessKey, looking?.id),
        },
        earlier: earlier || undefined,
      });
    } catch (e) {
      store.failRequest(id, errorMessage(e));
    }
  };

  // Requests made elsewhere in the app (useAgentStore().ask)
  const pendingAsk = useAgentStore((s) => s.pendingAsk);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (pendingAsk === null) return;
    const text = useAgentStore.getState().takePendingAsk();
    if (text) askRef.current(text);
  }, [pendingAsk]);

  /** Leave the shown conversation: the backend lets go of it unless it is still working */
  const leave = () => {
    if (chatId && !running) agent.reset(chatId).catch(() => {});
  };
  const newChat = () => {
    if (!accessKey) return;
    if (items.length > 0) {
      leave();
      useAgentStore.getState().newChat(accessKey);
    }
    inputRef.current?.focus();
  };
  const openChat = (id: string) => {
    if (!accessKey || id === chatId) return;
    leave();
    useAgentStore.getState().openChat(accessKey, id);
  };
  const deleteChat = () => {
    if (!chatId) return;
    stopWrites(chatId);
    agent.cancel(chatId).catch(() => {});
    agent.reset(chatId).catch(() => {});
    useAgentStore.getState().deleteChat(chatId);
  };

  const signOut = async (logout: () => Promise<void>) => {
    try {
      await logout();
      await refreshBackends();
    } catch (e) {
      toast.error(t("panel.signOutFailed"), { description: errorMessage(e) });
    }
  };

  const removeKey = async (provider: KeyProvider) => {
    try {
      await agent.deleteKey(provider);
      await refreshBackends();
    } catch (e) {
      toast.error(t("panel.removeKeyFailed"), { description: errorMessage(e) });
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/40 pl-3 pr-1">
        {/* No icon: the toggle beside the tabs, right next to it, shows it */}
        <span className="text-xs font-medium">{t("panel.title")}</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={newChat} aria-label={t("panel.newConversation")} disabled={!accessKey}>
              <SquarePen className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("panel.newConversation")}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t("panel.earlierConversations")} disabled={!accessKey}>
                  <History className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("panel.earlierConversations")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
            {pastChats.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("panel.noConversations")}</div>
            ) : (
              pastChats.map(([id, c]) => (
                <DropdownMenuItem key={id} onSelect={() => openChat(id)} className="flex items-start gap-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs">{c.title || t("panel.untitled")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {c.running ? t("panel.working") : ago(c.updatedAt)}
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
                  {t("panel.deleteConversation")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t("panel.settings")}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setBackend("claude-code")} disabled={!info?.claudeCode}>
              <Terminal className="h-3.5 w-3.5" />
              <span className="flex-1">{t("panel.useClaudeCode")}</span>
              {backend === "claude-code" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackend("console")}>
              <UserRound className="h-3.5 w-3.5" />
              <span className="flex-1">{t("panel.useAnthropicAccount")}</span>
              {backend === "console" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackend("api")}>
              <KeyRound className="h-3.5 w-3.5" />
              <span className="flex-1">{t("panel.useAnthropicKey")}</span>
              {backend === "api" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setBackend("codex")} disabled={!info?.codex}>
              <Terminal className="h-3.5 w-3.5" />
              <span className="flex-1">{t("panel.useCodex")}</span>
              {backend === "codex" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackend("openai")}>
              <KeyRound className="h-3.5 w-3.5" />
              <span className="flex-1">{t("panel.useOpenaiKey")}</span>
              {backend === "openai" && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setEditingKey(openai ? "openai" : "anthropic")}>
              {t("panel.changeKey")}
            </DropdownMenuItem>
            {info?.hasApiKey && (
              <DropdownMenuItem onSelect={() => removeKey("anthropic")}>{t("panel.removeAnthropicKey")}</DropdownMenuItem>
            )}
            {info?.hasOpenaiKey && (
              <DropdownMenuItem onSelect={() => removeKey("openai")}>{t("panel.removeOpenaiKey")}</DropdownMenuItem>
            )}
            {info?.console?.signedIn && (
              <DropdownMenuItem onSelect={() => signOut(agent.consoleLogout)}>
                {t("panel.signOutAnthropic")}
              </DropdownMenuItem>
            )}
            {info?.codex?.signedIn && (
              <DropdownMenuItem onSelect={() => signOut(agent.codexLogout)}>{t("panel.signOutChatgpt")}</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(false)} aria-label={t("panel.closeAgent")}>
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
          {t("panel.openDatabase")}
        </div>
      ) : (
        <>
          {/* Conversation: selectable and copyable, unlike the app's chrome */}
          <div ref={scrollRef} className="allow-select flex-1 overflow-y-auto px-3 py-3">
            {items.length === 0 ? (
              <div className="flex flex-col gap-3 pt-6 text-sm">
                <p className="text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey={target === "new" ? "panel.introNew" : "panel.introCurrent"}
                    values={{ tab: activeTab?.title ?? t("panel.yourTab"), name: conn.name }}
                    components={{ b: <span className="text-foreground" /> }}
                  />
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
                    {t("panel.working")}
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
                placeholder={t("panel.placeholder")}
              />
              <div className="flex items-center gap-1 px-1.5 pb-1.5">
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger aria-label={t("panel.model")} className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" side="top" align="start">
                    {models.length === 0 && (
                      <SelectItem value="__loading" disabled className="text-xs">
                        {t("panel.loading")}
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
                  <Tip label={t("panel.whereTitle")}>
                    <SelectTrigger
                      aria-label={t("panel.whereLabel")}
                      className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs shadow-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                  </Tip>
                  <SelectContent position="popper" side="top" align="start">
                    <SelectItem value="new" className="text-xs">{t("panel.newTab")}</SelectItem>
                    <SelectItem value="current" className="text-xs">{t("panel.thisTab")}</SelectItem>
                  </SelectContent>
                </Select>
                <Tip label={t("panel.writesTitle")}>
                  <label
                    className={cn(
                      // Shrinks (ending in …) before it pushes Send out of a narrow panel
                      "flex min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-1.5 text-xs",
                      allowWrites ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
                    )}
                  >
                    <Switch
                      checked={allowWrites}
                      onCheckedChange={(v) => setWriteAccess(accessKey, v)}
                      className="scale-75"
                      aria-label={t("panel.allowWrites")}
                    />
                    <span className="truncate">{t("panel.runWrites")}</span>
                  </label>
                </Tip>
                <div className="flex-1" />
                {running ? (
                  <Button size="icon" variant="secondary" className="h-6 w-6" onClick={() => {
                      stopWrites(chatId!);
                      agent.cancel(chatId!);
                    }} aria-label={t("panel.stop")}>
                    <Square className="h-3 w-3" />
                  </Button>
                ) : (
                  <Button size="icon" className="h-6 w-6" onClick={() => ask(draft)} disabled={!draft.trim() || !model} aria-label={t("panel.send")}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1 px-1 text-[11px] text-muted-foreground/70">
              {backend === "claude-code"
                ? `Claude Code${info?.claudeCode?.version ? ` ${info.claudeCode.version.split(" ")[0]}` : ""}`
                : backend === "console"
                  ? t("panel.anthropicAccount")
                  : backend === "codex"
                    ? t("panel.chatgptViaCodex")
                    : backend === "openai"
                      ? t("panel.openaiKey")
                      : t("panel.anthropicKey")}{" "}
              · {t("panel.hints", { mod })}
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
  const { t } = useTranslation("agent");
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<KeyProvider>(keyProvider);
  const [codexSigningIn, setCodexSigningIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signInStep, setSignInStep] = useState<"idle" | "setup" | "approve">("idle");
  const [showKey, setShowKey] = useState(!!onCancel);
  const save = async () => {
    setSaving(true);
    try {
      await agent.setKey(provider, key);
      setKey("");
      onUse(provider === "openai" ? "openai" : "api");
    } catch (e) {
      toast.error(t("setup.saveKeyFailed"), { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  const signIn = async () => {
    try {
      // First time only: fetch the sign-in tool
      if (!info.console?.installed) {
        setSignInStep("setup");
        await agent.consoleInstall();
      }
      setSignInStep("approve");
      await agent.consoleLogin();
      onUse("console");
    } catch (e) {
      toast.error(t("setup.signInFailed"), { description: errorMessage(e) });
    } finally {
      setSignInStep("idle");
    }
  };
  const codexSignIn = async () => {
    setCodexSigningIn(true);
    try {
      await agent.codexLogin();
      onUse("codex");
    } catch (e) {
      toast.error(t("setup.signInFailed"), { description: errorMessage(e) });
    } finally {
      setCodexSigningIn(false);
    }
  };
  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-4 text-sm">
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <Terminal className="h-3.5 w-3.5" /> Claude Code
          <span className="text-xs font-normal text-muted-foreground">{t("setup.recommended")}</span>
        </h3>
        {info.claudeCode ? (
          <>
            <p className="text-muted-foreground">
              {t("setup.claudeCodeFound", { version: info.claudeCode.version ?? "Claude Code" })}
            </p>
            <Button size="sm" onClick={() => onUse("claude-code")}>
              {t("panel.useClaudeCode")}
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">
            <Trans t={t} i18nKey="setup.claudeCodeInstall" components={{ cmd: <span className="font-data text-xs" /> }} />
          </p>
        )}
      </section>

      {info.console && (
        <section className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <h3 className="flex items-center gap-1.5 font-medium">
            <UserRound className="h-3.5 w-3.5" /> {t("setup.anthropicAccount")}
          </h3>
          <p className="text-muted-foreground">
            {t("setup.anthropicAccountText")}
          </p>
          {info.console?.signedIn ? (
            <Button size="sm" variant="outline" onClick={() => onUse("console")}>
              {t("panel.useAnthropicAccount")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={signIn} disabled={signInStep !== "idle"}>
              <LogIn className="h-3.5 w-3.5" />
              {signInStep === "setup"
                ? t("setup.settingUp")
                : signInStep === "approve"
                  ? t("setup.waitingApproval")
                  : t("setup.signInBrowser")}
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
              {t("setup.codexFound", { version: info.codex.version ?? "Codex" })}
            </p>
            {info.codex.signedIn ? (
              <Button size="sm" variant="outline" onClick={() => onUse("codex")}>
                {t("setup.useChatgpt")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={codexSignIn} disabled={codexSigningIn}>
                <LogIn className="h-3.5 w-3.5" />
                {codexSigningIn ? t("setup.waitingApproval") : t("setup.signInChatgpt")}
              </Button>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            {t("setup.codexInstall")}
          </p>
        )}
      </section>

      {!info.claudeCode || !info.codex ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={onRecheck}>
          {t("setup.checkAgain")}
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
            <KeyRound className="h-3.5 w-3.5" /> {t("setup.apiKey")}
          </h3>
          <div className="flex gap-1" role="radiogroup" aria-label={t("setup.whoseKey")}>
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
            {t("setup.keyText", {
              site: provider === "anthropic" ? "console.anthropic.com" : "platform.openai.com",
              provider: provider === "anthropic" ? "Anthropic" : "OpenAI",
            })}
          </p>
          <Input
            type="password"
            autoComplete="off"
            placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={provider === "anthropic" ? t("panel.anthropicKey") : t("panel.openaiKey")}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="outline" className="flex-1" disabled={!key.trim() || saving}>
              {saving ? t("setup.saving") : t("setup.saveKey")}
            </Button>
            {onCancel && (
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                {t("setup.cancel")}
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
          {t("setup.useKeyInstead")}
        </button>
      )}
    </div>
  );
}

function ItemView({ item, conversationId }: { item: AgentItem; conversationId: string }) {
  switch (item.kind) {
    case "user":
      return (
        // Set apart from the agent's replies: black in light mode, a raised grey in dark
        <div className="self-end max-w-[90%] whitespace-pre-wrap rounded-2xl bg-black px-3 py-2 text-sm text-white dark:bg-[#2f2f2f] dark:text-foreground">
          {item.text}
        </div>
      );
    case "text":
      return <Reply text={item.text} />;
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return <ToolStep item={item} />;
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

/** An agent reply, with a Copy button (its Markdown) that shows on hover */
function Reply({ text }: { text: string }) {
  const { t } = useTranslation("agent");
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(t("code.copied")),
      () => toast.error(t("code.copyFailed")),
    );
  return (
    <div className="group/reply">
      <MessageText text={text} />
      <div className="mt-0.5 flex justify-end opacity-0 transition-opacity group-hover/reply:opacity-100 focus-within:opacity-100">
        <Tip label={t("reply.copy")}>
          <button
            type="button"
            onClick={copy}
            aria-label={t("reply.copy")}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
        </Tip>
      </div>
    </div>
  );
}

/**
 * A tool step. A check_query opens to show what the agent ran and got back,
 * so a check that left the tab alone is still in front of the user.
 */
function ToolStep({ item }: { item: Extract<AgentItem, { kind: "tool" }> }) {
  const { t } = useTranslation("agent");
  const [open, setOpen] = useState(false);
  const tone = item.isError ? "text-destructive" : "text-muted-foreground";
  const d = item.detail;
  if (!d) {
    return (
      <div className={cn("flex items-start gap-1.5 text-xs", tone)}>
        <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{item.summary}</span>
      </div>
    );
  }
  const shown = d.rows?.length ?? 0;
  return (
    <div className="text-xs">
      <button
        type="button"
        className={cn("flex items-start gap-1.5 text-left hover:text-foreground", tone)}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={t("check.toggle")}
      >
        <ChevronRight className={cn("mt-0.5 h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span>{item.summary}</span>
      </button>
      {open && (
        <div className="agent-md mt-1 ml-[18px] overflow-hidden rounded-md border border-border/60">
          <pre className="font-data max-h-40 overflow-auto whitespace-pre-wrap bg-muted px-2 py-1.5">{highlightSql(d.sql)}</pre>
          {d.error ? (
            <div className="px-2 py-1.5 text-destructive">{d.error}</div>
          ) : (
            d.columns && (
              <div className="max-h-48 overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      {d.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows?.map((row, i) => (
                      <tr key={i}>
                        {row.map((v, j) => (
                          <td key={j} className={cn("font-data", v === null && "italic text-muted-foreground")}>
                            {v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          <div className="border-t border-border/60 px-2 py-1 text-muted-foreground">
            {d.rowCount !== undefined &&
              t("check.summary", { count: d.rowCount, time: d.time }) +
                ((d.runs ?? 1) > 1 ? ` (${t("check.median", { runs: d.runs })})` : "") +
                (d.rowCount > shown ? ` (${t("check.firstShown", { shown })})` : "") +
                " · "}
            {t("check.rolledBack")}
          </div>
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const { t } = useTranslation("agent");
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        {t("thinking")}
      </button>
      {open && <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-2">{text}</p>}
    </div>
  );
}

function Proposal({
  item,
  conversationId,
}: {
  item: Extract<AgentItem, { kind: "proposal" }>;
  conversationId: string;
}) {
  const { t } = useTranslation("agent");
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
    useAgentStore.getState().setApplied(conversationId, item.id, applied);
  };

  // This block's SQL: in its tab if the tab still holds it, else in a new
  // tab, so a later edit or query in that tab is neither run nor lost
  const run = () => {
    const editor = useEditorStore.getState();
    const id = tab && tab.sql === item.sql ? tab.id : editor.addTab(t("tabTitle"), item.sql);
    runInTab(id, item.sql);
  };

  const copy = () => {
    navigator.clipboard.writeText(item.sql).then(
      () => toast.success(t("proposal.sqlCopied")),
      () => toast.error(t("proposal.copyFailed")),
    );
  };

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-xs">
        <SquarePen className="h-3 w-3 text-primary" />
        <span className="flex-1 truncate">
          <Trans
            t={t}
            i18nKey={item.applied ? "proposal.edited" : "proposal.undoneIn"}
            values={{ tab: tab?.title ?? t("proposal.closedTab") }}
            components={{ b: <span className="font-medium" /> }}
          />
          {item.applied && item.autoRan && <span className="text-muted-foreground">{t("proposal.ranIt")}</span>}
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
                ? t("proposal.replaced", { count: line.count })
                : t("proposal.unchanged", { count: line.count })}
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
          <Tip label={item.autoRan ? t("proposal.runAgainTitle") : t("proposal.runTitle")}>
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              variant={item.autoRan ? "ghost" : "default"}
              onClick={run}
            >
              <Play className="h-3 w-3" /> {item.autoRan ? t("proposal.runAgain") : t("proposal.run")}
            </Button>
          </Tip>
        )}
        {tab &&
          (item.applied ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setApplied(false)}>
              <Undo2 className="h-3 w-3" /> {t("proposal.undo")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setApplied(true)}>
              <Redo2 className="h-3 w-3" /> {t("proposal.applyAgain")}
            </Button>
          ))}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={copy}>
          <Copy className="h-3 w-3" /> {t("proposal.copy")}
        </Button>
        {editedSince && (
          <span className="ml-auto truncate pr-1 text-[11px] text-amber-600 dark:text-amber-400">
            {t("proposal.editedSince")}
          </span>
        )}
      </div>
    </div>
  );
}
