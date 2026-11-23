import { useSyncExternalStore } from "react";

// Where a query result's grid puts its Search and Copy: the query toolbar
// above it, which is the grid's sibling, not its parent.
let target: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setQueryGridActions(el: HTMLElement | null) {
  target = el;
  listeners.forEach((l) => l());
}

export function useQueryGridActions(): HTMLElement | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => target,
  );
}
