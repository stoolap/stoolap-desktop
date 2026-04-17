
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Play,
  FileSearch,
  Loader2,
  FileOutput,
  History,
  AlignLeft,
  Square,
  FolderOpen,
  Save,
  Bookmark,
  BookmarkCheck,
  X,
} from "lucide-react";
import { useQueryExecution } from "@/hooks/use-query-execution";
import { useEditorStore } from "@/stores/editor-store";
import { useBookmarkStore } from "@/stores/bookmark-store";
import type { ApiResult, QueryResult } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatSQL } from "@/lib/sql-formatter";
import { saveFile, escapeCSV } from "@/lib/utils";
import { useModKey } from "@/hooks/use-mod-key";

function resultStats(result: ApiResult | null) {
  if (!result) return null;
  if ("error" in result && result.error) return null;
  if ("columns" in result) {
    return `${result.rows.length} row${result.rows.length !== 1 ? "s" : ""} | ${result.time}ms`;
  }
  if ("ddl" in result) {
    return `${result.ddl} | ${result.time}ms`;
  }
  if ("changes" in result) {
    return `${result.changes} affected | ${result.time}ms`;
  }
  return null;
}

function exportCSV(result: QueryResult, name: string) {
  const header = result.columns.map(escapeCSV).join(",");
  const rows = result.rows.map((r) => r.map(escapeCSV).join(","));
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  saveFile([header, ...rows].join("\n"), `${name}_${ts}.csv`, "text/csv");
}

function exportJSON(result: QueryResult, name: string) {
  const objs = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  saveFile(
    JSON.stringify(objs, null, 2),
    `${name}_${ts}.json`,
    "application/json",
  );
}

export function QueryToolbar() {
  const { executeQuery, cancelQuery, isConnected } = useQueryExecution();
  const activeTab = useEditorStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null,
  );
  const updateTabSql = useEditorStore((s) => s.updateTabSql);
  const addTab = useEditorStore((s) => s.addTab);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const queryHistory = useEditorStore((s) => s.queryHistory);
  const { bookmarks, addBookmark, removeBookmark } = useBookmarkStore();
  const mod = useModKey();
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [bookmarkName, setBookmarkName] = useState("");
  const saveInputRef = useRef<HTMLInputElement | null>(null);

  const handleRun = () => {
    if (activeTab && activeTab.sql.trim()) {
      executeQuery(activeTab.id, activeTab.sql);
    }
  };

  const handleExplain = () => {
    if (activeTab && activeTab.sql.trim()) {
      const sql = activeTab.sql.trimStart();
      const query = sql.toUpperCase().startsWith("EXPLAIN")
        ? sql
        : `EXPLAIN ${sql}`;
      executeQuery(activeTab.id, query);
    }
  };

  const handleFormat = () => {
    if (activeTab && activeTab.sql.trim()) {
      const formatted = formatSQL(activeTab.sql);
      updateTabSql(activeTab.id, formatted);
    }
  };

  const handleCancel = () => {
    if (activeTab) cancelQuery(activeTab.id);
  };

  const handleOpenFile = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const selected = await open({
      multiple: false,
      filters: [
        { name: "SQL Files", extensions: ["sql"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (typeof selected !== "string") return;
    const sql = await readTextFile(selected);
    const tabName = selected.split("/").pop()?.replace(/\.sql$/i, "") ?? "Query";
    const tabId = addTab(tabName, sql);
    setActiveTab(tabId);
  };

  const handleSaveBookmark = () => {
    if (!activeTab?.sql.trim()) return;
    if (!showSaveInput) {
      setBookmarkName(activeTab.title);
      setShowSaveInput(true);
      requestAnimationFrame(() => saveInputRef.current?.focus());
      return;
    }
    if (bookmarkName.trim()) {
      addBookmark(bookmarkName.trim(), activeTab.sql);
      setShowSaveInput(false);
      setBookmarkName("");
    }
  };

  const handleLoadBookmark = (sql: string, name: string) => {
    const tabId = addTab(name, sql);
    setActiveTab(tabId);
  };

  // Elapsed timer while query is running
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunning = activeTab?.isRunning ?? false;

  useEffect(() => {
    if (isRunning) {
      setElapsed(0); // eslint-disable-line react-hooks/set-state-in-effect -- reset timer on run
      const start = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - start) / 1000);
      }, 100);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning]);

  const stats = activeTab ? resultStats(activeTab.result) : null;
  const hasQueryResult =
    activeTab?.result &&
    "columns" in activeTab.result &&
    !activeTab.result.error;
  const exportName = activeTab?.title?.replace(/\s+/g, "_") ?? "export";

  return (
    <div className="flex items-center gap-0.5 px-1.5 h-8 border-b panel-toolbar shrink-0">
      {/* Execute */}
      <Tooltip>
        <TooltipTrigger asChild>
          {activeTab?.isRunning ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleCancel}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleRun}
              disabled={!isConnected || !activeTab?.sql.trim()}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <Play className="h-3 w-3" />
              Run
            </Button>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {activeTab?.isRunning
            ? "Cancel query"
            : !isConnected
              ? "Connect to a database first"
              : !activeTab?.sql.trim()
                ? "Write a query to execute"
                : `Execute query (${mod}+Enter)`}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleExplain}
            disabled={
              !isConnected || !activeTab?.sql.trim() || activeTab?.isRunning
            }
          >
            <FileSearch className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Explain query plan ({mod}+E)
        </TooltipContent>
      </Tooltip>

      <div className="toolbar-separator" />

      {/* Edit */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleFormat}
            disabled={!activeTab?.sql.trim()}
          >
            <AlignLeft className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Format SQL ({mod}+Shift+F)
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleOpenFile}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open .sql file</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              if (activeTab?.sql.trim()) {
                const name = activeTab.title.replace(/\s+/g, "_");
                saveFile(activeTab.sql, `${name}.sql`, "text/plain");
              }
            }}
            disabled={!activeTab?.sql.trim()}
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Save as .sql</TooltipContent>
      </Tooltip>


      {hasQueryResult && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <FileOutput className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Export results</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() => {
                const r = activeTab?.result;
                if (r && "columns" in r)
                  exportCSV(r as QueryResult, exportName);
              }}
            >
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const r = activeTab?.result;
                if (r && "columns" in r)
                  exportJSON(r as QueryResult, exportName);
              }}
            >
              Export as JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="toolbar-separator" />

      {/* Library */}
      {queryHistory.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <History className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Query history</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-80">
            <ScrollArea className="max-h-60">
              {queryHistory.map((sql) => (
                <DropdownMenuItem
                  key={sql}
                  className="text-xs font-data py-1"
                  onClick={() => {
                    if (activeTab) {
                      updateTabSql(activeTab.id, sql);
                    }
                  }}
                >
                  <span className="truncate">{sql}</span>
                </DropdownMenuItem>
              ))}
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleSaveBookmark}
            disabled={!activeTab?.sql.trim()}
          >
            <BookmarkCheck className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Save bookmark</TooltipContent>
      </Tooltip>

      {showSaveInput && (
        <form
          className="flex items-center gap-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveBookmark();
          }}
        >
          <input
            ref={saveInputRef}
            className="h-7 w-32 px-2 text-xs border rounded bg-background"
            placeholder="Bookmark name"
            value={bookmarkName}
            onChange={(e) => setBookmarkName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setShowSaveInput(false);
                setBookmarkName("");
              }
            }}
          />
          <Button type="submit" size="sm" variant="ghost" className="h-7 px-2 text-xs">
            OK
          </Button>
        </form>
      )}

      {bookmarks.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <Bookmark className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Bookmarks</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-72">
            <ScrollArea className="max-h-60">
              {bookmarks.map((bm) => (
                <DropdownMenuItem
                  key={bm.id}
                  className="text-xs py-1 flex items-center gap-2"
                  onClick={() => handleLoadBookmark(bm.sql, bm.name)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{bm.name}</div>
                    <div className="text-xs text-muted-foreground truncate font-data">
                      {bm.sql.slice(0, 80)}
                    </div>
                  </div>
                  <button
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeBookmark(bm.id);
                    }}
                    aria-label={`Remove bookmark ${bm.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </DropdownMenuItem>
              ))}
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="flex-1" />
      {isRunning && (
        <span className="text-xs text-muted-foreground tabular-nums flex items-center gap-1">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          {elapsed.toFixed(1)}s
        </span>
      )}
      {!isRunning && stats && (
        <span className="text-xs text-muted-foreground/70 tabular-nums">
          {stats}
        </span>
      )}
    </div>
  );
}
