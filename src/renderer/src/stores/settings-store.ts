import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Choices for the engine's query timeout; 0 turns it off. */
export const QUERY_TIMEOUT_OPTIONS = [
  { ms: 30_000, label: "30 s" },
  { ms: 60_000, label: "1 min" },
  { ms: 300_000, label: "5 min" },
  { ms: 900_000, label: "15 min" },
  { ms: 3_600_000, label: "1 hour" },
  { ms: 0, label: "Off" },
] as const;

export function queryTimeoutLabel(ms: number): string {
  return QUERY_TIMEOUT_OPTIONS.find((o) => o.ms === ms)?.label ?? `${ms / 1000} s`;
}

interface SettingsState {
  /** Matches DEFAULT_QUERY_TIMEOUT_MS in src-tauri/src/db.rs */
  queryTimeoutMs: number;
  setQueryTimeoutMs: (ms: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      queryTimeoutMs: 300_000,
      setQueryTimeoutMs: (ms) => set({ queryTimeoutMs: ms }),
    }),
    { name: "stoolap-settings" },
  ),
);
