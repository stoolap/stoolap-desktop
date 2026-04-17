import { useState, useEffect, useCallback, useRef } from "react";
import { errorMessage } from "@/lib/utils";
import { Toolbar } from "./toolbar";
import { Sidebar } from "./sidebar";
import { EditorTabs } from "@/components/editor/editor-tabs";
import { SqlEditor } from "@/components/editor/sql-editor";
import { QueryToolbar } from "@/components/editor/query-toolbar";
import { ResultsPanel } from "@/components/results/results-panel";
import { TableViewer } from "@/components/data/table-viewer";
import { KeyboardShortcuts } from "@/components/common/keyboard-shortcuts";
import { useEditorStore } from "@/stores/editor-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useTableColumns, useEditorSchema } from "@/hooks/use-schema";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as native from "@/lib/native";

const SIDEBAR_WIDTH_DEFAULT = 240;
const EDITOR_HEIGHT_DEFAULT = 220;
const IS_MAC = navigator.userAgent.includes("Mac");

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH_DEFAULT);
  const [editorHeight, setEditorHeight] = useState(EDITOR_HEIGHT_DEFAULT);
  const [isDark, setIsDark] = useState(false);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingEditor, setIsResizingEditor] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const editorHeightRef = useRef(editorHeight);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
    editorHeightRef.current = editorHeight;
  });

  const activeTab = useEditorStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null,
  );
  const tabs = useEditorStore((s) => s.tabs);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const activeId = useConnectionStore((s) => s.activeId);
  const connections = useConnectionStore((s) => s.connections);
  const activeConn = connections.find((c) => c.id === activeId);

  const setConnections = useConnectionStore((s) => s.setConnections);
  const setActiveId = useConnectionStore((s) => s.setActiveId);

  // Get app version
  useEffect(() => {
    native.getVersion().then(setAppVersion);
  }, []);

  // Restore persisted layout sizes
  useEffect(() => {
    try {
      const sw = localStorage.getItem("stoolap-sidebar-width");
      if (sw) setSidebarWidth(Number(sw) || SIDEBAR_WIDTH_DEFAULT);
      const eh = localStorage.getItem("stoolap-editor-height");
      if (eh) setEditorHeight(Number(eh) || EDITOR_HEIGHT_DEFAULT);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // On mount: close Example DB, then sync connections
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await native.closeExample();
        if (cancelled) return;
        const remaining = await native.listConnections();
        if (cancelled) return;
        setConnections(remaining);
        const currentActiveId = useConnectionStore.getState().activeId;
        if (
          remaining.length > 0 &&
          !remaining.find((c: { id: string }) => c.id === currentActiveId)
        ) {
          setActiveId(remaining[0].id);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set first tab active if none selected
  useEffect(() => {
    if (!activeTab && tabs.length > 0) {
      setActiveTab(tabs[0].id);
    }
  }, [activeTab, tabs, setActiveTab]);

  // Watch dark mode changes (for CodeMirror theme)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    setIsDark(document.documentElement.classList.contains("dark"));
    return () => observer.disconnect();
  }, []);

  // Listen for sidebar toggle (Cmd+B via keyboard shortcut or native menu)
  useEffect(() => {
    const handler = () => setSidebarOpen((prev) => !prev);
    window.addEventListener("stoolap:toggle-sidebar", handler);
    const cleanup = native.onMenuToggleSidebar(handler);
    return () => {
      window.removeEventListener("stoolap:toggle-sidebar", handler);
      cleanup();
    };
  }, []);

  const handleSidebarMouseDown = useCallback(() => {
    setIsResizingSidebar(true);
  }, []);

  const handleEditorMouseDown = useCallback(() => {
    setIsResizingEditor(true);
  }, []);

  useEffect(() => {
    if (!isResizingSidebar && !isResizingEditor) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = isResizingSidebar
      ? "col-resize"
      : "row-resize";

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const newWidth = Math.max(160, Math.min(500, e.clientX));
        setSidebarWidth(newWidth);
      }
      if (isResizingEditor && editorAreaRef.current) {
        const rect = editorAreaRef.current.getBoundingClientRect();
        const newHeight = Math.max(60, Math.min(600, e.clientY - rect.top));
        setEditorHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      if (isResizingSidebar) {
        localStorage.setItem(
          "stoolap-sidebar-width",
          String(sidebarWidthRef.current),
        );
      }
      if (isResizingEditor) {
        localStorage.setItem(
          "stoolap-editor-height",
          String(editorHeightRef.current),
        );
      }
      setIsResizingSidebar(false);
      setIsResizingEditor(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSidebar, isResizingEditor]);

  const editorSchema = useEditorSchema();
  const isDataTab = activeTab?.mode === "data" && activeTab.tableName;

  return (
    <div className="h-screen flex flex-col text-foreground">
      <KeyboardShortcuts />
      {/* Headless toolbar — just manages dialogs */}
      <Toolbar />

      {/* macOS title bar drag region with centered title */}
      {IS_MAC && (
        <div
          data-tauri-drag-region
          className="h-[38px] shrink-0 drag-region flex items-center justify-center"
          onDoubleClick={async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            getCurrentWindow().toggleMaximize();
          }}
        >
          <span className="text-xs text-muted-foreground/60 font-medium tracking-tight pointer-events-none">
            {activeConn ? activeConn.name : "Stoolap Desktop"}
          </span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar — transparent for macOS vibrancy */}
        {sidebarOpen && (
          <>
            <div
              style={{ width: sidebarWidth }}
              className="shrink-0 overflow-hidden border-r border-border/40 bg-sidebar "
            >
              <Sidebar />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              className="w-px cursor-col-resize hover:w-0.5 hover:bg-primary/30 active:bg-primary/50 shrink-0 bg-transparent"
              onMouseDown={handleSidebarMouseDown}
            />
          </>
        )}

        {/* Main content area — opaque background */}
        <div
          ref={editorAreaRef}
          className="flex-1 flex flex-col overflow-hidden bg-background"
        >
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-none"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-3 w-3" />
              ) : (
                <PanelLeft className="h-3 w-3" />
              )}
            </Button>
            <div className="flex-1 overflow-hidden">
              <EditorTabs />
            </div>
          </div>

          {isDataTab ? (
            <DataTabContent
              tableName={activeTab.tableName!}
              initialFilter={activeTab.initialFilter}
            />
          ) : (
            <>
              <div
                style={{ height: editorHeight }}
                className="shrink-0 overflow-hidden"
              >
                {activeTab && (
                  <SqlEditor
                    tabId={activeTab.id}
                    value={activeTab.sql}
                    isDark={isDark}
                    schema={editorSchema}
                  />
                )}
              </div>

              <QueryToolbar />

              <div
                role="separator"
                aria-orientation="horizontal"
                className="h-px cursor-row-resize hover:h-0.5 hover:bg-primary/30 active:bg-primary/50 shrink-0 bg-border/30"
                onMouseDown={handleEditorMouseDown}
              />

              <div className="flex-1 overflow-hidden">
                <ResultsPanel />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center h-8 border-t text-xs bg-background shrink-0">
        <div className="flex items-center gap-1.5 px-3 h-full">
          {activeConn ? (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              <span className="text-foreground/80">{activeConn.name}</span>
              <span className="text-muted-foreground">
                — {activeConn.type === "memory" ? "In-Memory" : activeConn.path}
              </span>
            </>
          ) : (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />
              <span className="text-muted-foreground">No connection</span>
            </>
          )}
        </div>
        {activeTab && (
          <>
            <div className="w-px h-3 bg-border/50" />
            <div className="flex items-center px-3 h-full text-muted-foreground">
              {activeTab.mode === "data"
                ? activeTab.tableName
                : activeTab.title}
            </div>
          </>
        )}
        <div className="flex-1" />
        <div className="flex items-center px-3 h-full text-muted-foreground/60">
          v{appVersion}
        </div>
      </div>
    </div>
  );
}

function DataTabContent({
  tableName,
  initialFilter,
}: {
  tableName: string;
  initialFilter?: { column: string; value: string };
}) {
  const { data: columns, isLoading, error } = useTableColumns(tableName);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive text-xs">
        Table &quot;{tableName}&quot; is no longer available:{" "}
        {errorMessage(error)}
      </div>
    );
  }

  if (isLoading || !columns) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
        Loading table schema...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden">
      <TableViewer
        table={tableName}
        columns={columns}
        initialFilter={initialFilter}
      />
    </div>
  );
}
