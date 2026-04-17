
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
import { Database, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as native from "@/lib/native";

export function Sidebar() {
  const connections = useConnectionStore((s) => s.connections);
  const activeId = useConnectionStore((s) => s.activeId);
  const setActiveId = useConnectionStore((s) => s.setActiveId);
  const { disconnect } = useConnection();
  const activeConn = connections.find((c) => c.id === activeId);

  const handleDisconnect = async () => {
    if (!activeConn) return;
    const confirmed = await native.showConfirmDialog({
      title: "Disconnect",
      message: `Disconnect from "${activeConn.name}"?`,
      detail: "Unsaved queries and in-memory data will be lost.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (confirmed) {
      disconnect(activeConn.id);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Connection header */}
      <div className="px-1.5 pt-0.5 pb-1 border-b border-border/30">
        {connections.length > 0 ? (
          <div className="flex items-center gap-0.5">
            <Select value={activeId ?? ""} onValueChange={setActiveId}>
              <SelectTrigger className="h-7 text-xs flex-1 border-none bg-transparent shadow-none px-1.5">
                <div className="flex items-center gap-1.5">
                  <Database className="h-3 w-3 text-primary shrink-0" />
                  <SelectValue placeholder="Select connection" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {connections.map((conn) => (
                  <SelectItem key={conn.id} value={conn.id}>
                    <span className="text-xs">{conn.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeConn && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={handleDisconnect}
                  >
                    <X className="h-2.5 w-2.5 text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Disconnect</TooltipContent>
              </Tooltip>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-1.5 h-7 text-xs text-muted-foreground">
            <Database className="h-3 w-3 shrink-0" />
            No connections
          </div>
        )}
      </div>

      {/* Schema tree */}
      <div className="flex-1 overflow-hidden">
        <TableTree />
      </div>
    </div>
  );
}
