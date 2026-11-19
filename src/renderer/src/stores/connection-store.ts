import { create } from "zustand";
import type { ConnectionMeta } from "@/lib/types";

interface ConnectionState {
  connections: ConnectionMeta[];
  activeId: string | null;
  setConnections: (connections: ConnectionMeta[]) => void;
  setActiveId: (id: string | null) => void;
  addConnection: (meta: ConnectionMeta) => void;
  removeConnection: (id: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  activeId: null,
  setConnections: (connections) => set({ connections }),
  setActiveId: (activeId) => set({ activeId }),
  addConnection: (meta) =>
    set((s) => ({
      // When it opened: an in-memory database's history starts there
      connections: [...s.connections, { ...meta, createdAt: meta.createdAt ?? Date.now() }],
      activeId: meta.id,
    })),
  removeConnection: (id) =>
    set((s) => {
      const remaining = s.connections.filter((c) => c.id !== id);
      const nextActive =
        s.activeId === id ? (remaining[0]?.id ?? null) : s.activeId;
      return { connections: remaining, activeId: nextActive };
    }),
}));
