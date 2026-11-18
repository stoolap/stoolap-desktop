import { useEffect } from "react";
import { Timer } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { QUERY_TIMEOUT_OPTIONS, queryTimeoutLabel, useSettingsStore } from "@/stores/settings-store";
import * as api from "@/lib/api-client";

/** Status-bar control for the engine's query timeout. */
export function QueryTimeoutSelect() {
  const ms = useSettingsStore((s) => s.queryTimeoutMs);
  const setMs = useSettingsStore((s) => s.setQueryTimeoutMs);

  // Push the saved value to the backend at startup and on every change.
  useEffect(() => {
    api.setQueryTimeout(ms).catch(() => {});
  }, [ms]);

  return (
    <Select value={String(ms)} onValueChange={(v) => setMs(Number(v))}>
      <SelectTrigger
        aria-label="Query timeout"
        title="Query timeout: a query running longer than this is stopped"
        className="h-6 w-auto gap-1 px-2 text-xs border-0 bg-transparent shadow-none text-muted-foreground hover:text-foreground"
      >
        <Timer className="h-3 w-3" />
        <span>{ms === 0 ? "No query timeout" : `Query timeout ${queryTimeoutLabel(ms)}`}</span>
      </SelectTrigger>
      <SelectContent position="popper" side="top" align="end" className="w-60">
        <SelectGroup>
          <SelectLabel className="text-xs font-normal text-muted-foreground">
            Stop a query that runs longer than:
          </SelectLabel>
          {QUERY_TIMEOUT_OPTIONS.map((o) => (
            <SelectItem key={o.ms} value={String(o.ms)} className="text-xs">
              {o.ms === 0 ? "Never (no timeout)" : o.label}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectSeparator />
        <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
          Applies to every query, including the assistant&apos;s. A stopped query reports a timeout error.
        </p>
      </SelectContent>
    </Select>
  );
}
