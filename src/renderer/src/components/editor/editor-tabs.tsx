
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor-store";
import { useQueryExecution } from "@/hooks/use-query-execution";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Plus, X, Table2, FileCode, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function EditorTabs() {
  const { t } = useTranslation("editor");
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const addTab = useEditorStore((s) => s.addTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const updateTabTitle = useEditorStore((s) => s.updateTabTitle);
  const { cancelQuery } = useQueryExecution();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  // Bring the active tab into view: one opened past the right edge of a
  // full tab bar would otherwise stay hidden.
  const tabListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabListRef.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      updateTabTitle(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  return (
    <div className="flex items-center bg-muted/40">
      <div
        ref={tabListRef}
        role="tablist"
        className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
      >
        {tabs.map((tab) => (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              <div
                role="tab"
                aria-selected={activeTabId === tab.id}
                className={cn(
                  "group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer shrink-0 border-r border-border/15",
                  activeTabId === tab.id
                    ? "bg-background text-foreground"
                    : "text-muted-foreground/70 hover:text-foreground/80 hover:bg-background/40",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.mode === "data" ? (
                  <Table2 className="h-3 w-3 text-blue-400 shrink-0" />
                ) : (
                  <FileCode className="h-3 w-3 shrink-0 opacity-30" />
                )}
                {renamingId === tab.id ? (
                  <input
                    ref={renameInputRef}
                    className="w-20 bg-transparent text-xs outline-none border-b border-primary"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="truncate max-w-[100px]"
                    onDoubleClick={(e) => {
                      if (tab.mode !== "data") {
                        e.stopPropagation();
                        setRenamingId(tab.id);
                        setRenameValue(tab.title);
                      }
                    }}
                  >
                    {tab.title}
                  </span>
                )}
                {tab.isRunning && (
                  <Loader2
                    className="ml-0.5 h-2.5 w-2.5 animate-spin text-yellow-500"
                    aria-label={t("tabs.running")}
                  />
                )}
                {tabs.length > 1 && (
                  <button
                    className="ml-0.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelQuery(tab.id);
                      closeTab(tab.id);
                    }}
                    aria-label={t("tabs.close", { title: tab.title })}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {tab.mode === "data"
                ? t("tabs.dataTooltip", { title: tab.title })
                : t("tabs.renameTooltip", { title: tab.title })}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {/* Outside the scrolling list, so a full tab bar cannot push it off-screen */}
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0 mx-1 opacity-40 hover:opacity-100"
        onClick={() => addTab()}
        title={t("tabs.newTab")}
        aria-label={t("tabs.newTab")}
      >
        <Plus className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}
