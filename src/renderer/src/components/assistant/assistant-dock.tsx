import { useEffect, useState } from "react";
import * as assistant from "@/lib/assistant";
import * as native from "@/lib/native";
import { applyDraft, applyWrite } from "@/lib/assistant-edits";
import { useAssistantStore } from "@/stores/assistant-store";
import { AssistantPanel } from "./assistant-panel";

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

/**
 * Right-hand dock for the assistant. Stays mounted while closed so a running
 * request keeps streaming into its conversation.
 */
export function AssistantDock() {
  const open = useAssistantStore((s) => s.open);
  const width = useAssistantStore((s) => s.width);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const cleanups = [
      assistant.onEvent((id, event) => {
        if (event.kind === "draft") applyDraft(event.tabId, event.sql);
        else if (event.kind === "write") applyWrite(id, event);
        else useAssistantStore.getState().handleEvent(id, event);
      }),
      native.onMenuToggleAssistant(() => useAssistantStore.getState().toggle()),
    ];
    return () => cleanups.forEach((c) => c());
  }, []);

  useEffect(() => {
    if (!resizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (e: MouseEvent) => {
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - e.clientX));
      useAssistantStore.getState().setWidth(w);
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
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant"
        className="w-px shrink-0 cursor-col-resize bg-border/40 hover:w-0.5 hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={() => setResizing(true)}
      />
      <div style={{ width }} className="shrink-0 overflow-hidden">
        <AssistantPanel />
      </div>
    </>
  );
}
