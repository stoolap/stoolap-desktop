
import { useTranslation } from "react-i18next";
import { TableTree } from "@/components/schema/table-tree";
import { useConnectionStore } from "@/stores/connection-store";
import { useConnection } from "@/hooks/use-connection";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Database, X, MemoryStick } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as native from "@/lib/native";

export function Sidebar() {
  const { t } = useTranslation("schema");
  const connections = useConnectionStore((s) => s.connections);
  const activeId = useConnectionStore((s) => s.activeId);
  const setActiveId = useConnectionStore((s) => s.setActiveId);
  const { disconnect } = useConnection();
  const activeConn = connections.find((c) => c.id === activeId);

  const handleDisconnect = async () => {
    if (!activeConn) return;
    const confirmed = await native.showConfirmDialog({
      title: t("sidebar.disconnect"),
      message: t("sidebar.confirmDisconnect", { name: activeConn.name }),
      detail: t("sidebar.disconnectDetail"),
      confirmLabel: t("sidebar.disconnect"),
      destructive: true,
    });
    if (confirmed) {
      disconnect(activeConn.id);
    }
  };

  return (
    <div className="app-sidebar h-full flex flex-col">
      {/* Connection header: none without a connection, which the schema
          tree below says */}
      {connections.length > 0 && (
        <div className="px-2 pt-0.5 pb-1">
          <div className="px-2 pb-1 sidebar-heading text-xs font-semibold text-muted-foreground">{t("sidebar.database")}</div>
          {/* The menu and Disconnect as one capsule, a hairline between */}
          <div className="sidebar-field flex h-8 items-center">
            <Select value={activeId ?? ""} onValueChange={setActiveId}>
              <SelectTrigger className="h-8 min-w-0 text-xs flex-1 border-none shadow-none bg-transparent dark:bg-transparent dark:hover:bg-transparent focus-visible:ring-0 pl-3 pr-2">
                <div className="flex min-w-0 items-center gap-2">
                  {/* In memory: New In-Memory Database's icon */}
                  {activeConn?.type === "memory" ? (
                    <MemoryStick className="h-3.5 w-3.5 text-primary shrink-0" />
                  ) : (
                    <Database className="h-3.5 w-3.5 text-primary shrink-0" />
                  )}
                  <SelectValue placeholder={t("sidebar.selectConnection")} />
                </div>
              </SelectTrigger>
              {/* Below the button: aligned on the chosen item, the list
                  would rise over macOS' traffic lights */}
              <SelectContent position="popper" sideOffset={6} className="sidebar-menu">
                {connections.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id}>
                    <span className="text-xs">{conn.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeConn && (
              <Tooltip>
                <span aria-hidden className="h-4 w-px shrink-0 bg-foreground/15" />
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mx-1 h-6 w-6 shrink-0"
                    aria-label={t("sidebar.disconnect")}
                    onClick={handleDisconnect}
                  >
                    <X className="h-2.5 w-2.5 text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("sidebar.disconnect")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      )}

      {/* Schema tree */}
      <div className="flex-1 overflow-hidden">
        <TableTree />
      </div>
    </div>
  );
}
