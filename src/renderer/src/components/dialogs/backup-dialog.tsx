
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useConnectionStore } from "@/stores/connection-store";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/utils";
import { quoteId } from "@/lib/sql-utils";
import { parseForeignKeys } from "@/lib/fk-parser";
import * as api from "@/lib/api-client";
import {
  DEFAULT_DUMP_OPTIONS,
  generateHeader,
  generateInserts,
  generateTableIndexes,
  generateViewSection,
} from "@/lib/sql-dump";
import type { DumpOptions } from "@/lib/sql-dump";

interface BackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BackupDialog({ open, onOpenChange }: BackupDialogProps) {
  const activeId = useConnectionStore((s) => s.activeId);
  const connections = useConnectionStore((s) => s.connections);
  const activeConn = connections.find((c) => c.id === activeId);

  const [options, setOptions] = useState<DumpOptions>({
    ...DEFAULT_DUMP_OPTIONS,
  });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const resetAndClose = () => {
    setOptions({ ...DEFAULT_DUMP_OPTIONS });
    setLoading(false);
    setProgress("");
    setError("");
    onOpenChange(false);
  };

  const toggleOption = (key: keyof DumpOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleBackup = async () => {
    if (!activeId || !activeConn) return;
    setLoading(true);
    setError("");
    setProgress("Choosing file...");

    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const connName = activeConn.name.replace(/\s+/g, "_").toLowerCase();
    const path = await save({
      defaultPath: `${connName}_${ts}.sql`,
      filters: [{ name: "SQL Files", extensions: ["sql"] }],
    });
    if (!path) {
      setLoading(false);
      setProgress("");
      return;
    }

    // Stream writes chunk-by-chunk so large databases don't buffer the entire
    // dump in renderer memory before hitting disk.
    let firstWrite = true;
    const writeChunk = async (chunk: string) => {
      if (!chunk) return;
      await writeTextFile(path, chunk, firstWrite ? undefined : { append: true });
      firstWrite = false;
    };

    try {
      setProgress("Writing header...");
      await writeChunk(generateHeader(activeConn.name));

      if (options.tables) {
        setProgress("Fetching table list...");
        const tables = await api.fetchTables(activeId);

        setProgress("Analyzing table dependencies...");
        const tableOrder = await sortTablesByFKDeps(activeId, tables);

        for (let i = 0; i < tableOrder.length; i++) {
          const tableName = tableOrder[i];
          setProgress(
            `Exporting table ${i + 1}/${tableOrder.length}: ${tableName}`,
          );

          const ddl = await api.fetchDDL(activeId, tableName, "table");
          let section = `-- Table: ${tableName}\n`;
          if (options.dropBeforeCreate) {
            section += `DROP TABLE IF EXISTS ${quoteId(tableName)};\n`;
          }
          section += `${ddl};\n\n`;
          await writeChunk(section);

          if (options.data) {
            const PAGE = 10000;
            let pageOffset = 0;
            let columns: string[] = [];
            // Stream each page of rows straight to disk — never materialize the
            // whole table in memory.
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const page = await api.fetchTableRows(
                activeId,
                tableName,
                pageOffset,
                PAGE,
              );
              if (columns.length === 0) columns = page.columns;
              if (page.rows.length > 0) {
                await writeChunk(
                  generateInserts(tableName, columns, page.rows) + "\n",
                );
              }
              if (page.rows.length < PAGE) break;
              pageOffset += PAGE;
            }
            await writeChunk("\n");
          }

          if (options.indexes) {
            const indexes = await api.fetchIndexes(activeId, tableName);
            const indexSql = generateTableIndexes(tableName, indexes);
            if (indexSql) {
              await writeChunk(indexSql);
            }
          }
        }
      }

      if (options.views) {
        setProgress("Fetching views...");
        const views = await api.fetchViews(activeId);
        for (let i = 0; i < views.length; i++) {
          const viewName = views[i];
          setProgress(`Exporting view ${i + 1}/${views.length}: ${viewName}`);
          const ddl = await api.fetchDDL(activeId, viewName, "view");
          await writeChunk(generateViewSection(viewName, ddl, options));
        }
      }

      import("@/lib/native").then((n) =>
        n.notify("Backup Complete", `${activeConn.name} exported successfully`),
      );
      toast.success("Backup exported");
      resetAndClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetAndClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Save className="h-5 w-5" />
            Backup Database
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {activeConn && (
            <p className="text-sm text-muted-foreground">
              Export{" "}
              <span className="font-medium text-foreground">
                {activeConn.name}
              </span>{" "}
              as a SQL dump file.
            </p>
          )}

          <div className="space-y-3">
            <Label className="text-sm font-medium">Include</Label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={options.tables}
                onCheckedChange={() => toggleOption("tables")}
                disabled={loading}
              />
              Table structures (DDL)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={options.data}
                onCheckedChange={() => toggleOption("data")}
                disabled={loading || !options.tables}
              />
              Table data (INSERT statements)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={options.indexes}
                onCheckedChange={() => toggleOption("indexes")}
                disabled={loading || !options.tables}
              />
              Indexes
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={options.views}
                onCheckedChange={() => toggleOption("views")}
                disabled={loading}
              />
              Views
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={options.dropBeforeCreate}
                onCheckedChange={() => toggleOption("dropBeforeCreate")}
                disabled={loading}
              />
              DROP IF EXISTS before CREATE
            </label>
          </div>

          {progress && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              <span className="truncate">{progress}</span>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetAndClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleBackup} disabled={loading}>
            {loading ? "Exporting..." : "Export .sql"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Topologically sort tables so referenced tables come before tables with FKs.
 * Falls back to original order if cycles are detected.
 */
async function sortTablesByFKDeps(
  connId: string,
  tables: string[],
): Promise<string[]> {
  const tableSet = new Set(tables);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());

  for (const t of tables) {
    try {
      const ddl = await api.fetchDDL(connId, t, "table");
      const fks = parseForeignKeys(ddl);
      for (const fk of fks) {
        if (tableSet.has(fk.referencedTable) && fk.referencedTable !== t) {
          deps.get(t)!.add(fk.referencedTable);
        }
      }
    } catch {
      // If DDL fetch fails, keep original order for this table
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const t of tables) inDegree.set(t, 0);
  // Count how many tables depend on each table
  const dependedBy = new Map<string, string[]>();
  for (const t of tables) dependedBy.set(t, []);
  for (const [t, refs] of deps) {
    for (const ref of refs) {
      dependedBy.get(ref)!.push(t);
    }
  }
  for (const [t, refs] of deps) {
    inDegree.set(t, refs.size);
  }

  const queue: string[] = [];
  for (const [t, deg] of inDegree) {
    if (deg === 0) queue.push(t);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    sorted.push(t);
    for (const dependent of dependedBy.get(t) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  // If cycle detected (sorted.length < tables.length), fall back to original order
  return sorted.length === tables.length ? sorted : tables;
}
