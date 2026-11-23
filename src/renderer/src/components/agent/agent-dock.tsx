import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as agent from "@/lib/agent";
import * as native from "@/lib/native";
import { applyDraft, applyWrite } from "@/lib/agent-edits";
import { useAgentStore } from "@/stores/agent-store";
import { cn } from "@/lib/utils";
import { AgentPanel } from "./agent-panel";

const MIN_WIDTH = 300;
const IS_MAC = navigator.userAgent.includes("Mac");
const MAX_WIDTH = 720;

/**
 * The agent's dock, between the sidebar and the editor. Stays mounted while closed so a running
 * request keeps streaming into its conversation.
 */
export function AgentDock({ leftmost = false, toggles }: { leftmost?: boolean; toggles?: ReactNode }) {
  const { t } = useTranslation("agent");
  const open = useAgentStore((s) => s.open);
  const width = useAgentStore((s) => s.width);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanups = [
      agent.onEvent((id, event) => {
        if (event.kind === "draft") applyDraft(event.tabId, event.sql);
        else if (event.kind === "write") applyWrite(id, event);
        else useAgentStore.getState().handleEvent(id, event);
      }),
      native.onMenuToggleAgent(() => useAgentStore.getState().toggle()),
    ];
    return () => cleanups.forEach((c) => c());
  }, []);

  useEffect(() => {
    if (!resizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (e: MouseEvent) => {
      // The handle is on its right: the width runs from its left edge to the pointer
      const left = panelRef.current?.getBoundingClientRect().left ?? 0;
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - left));
      useAgentStore.getState().setWidth(w);
    };
    const up = () => setResizing(false);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [resizing]);

  if (!open) return null;
  return (
    <>
      {/* win-content-start: the first panel after the sidebar (Windows 11) */}
      <div ref={panelRef} style={{ width }} className="win-content win-content-start shrink-0 overflow-hidden">
        {/* With the sidebar hidden, macOS' traffic lights sit at its top */}
        <AgentPanel clearLights={IS_MAC && leftmost} toggles={IS_MAC && leftmost ? toggles : undefined} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("dock.resize")}
        className={cn(
          "shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50",
          IS_MAC ? "pane-divider" : "w-px bg-border/40 hover:w-0.5",
        )}
        onMouseDown={() => setResizing(true)}
      />
    </>
  );
}
