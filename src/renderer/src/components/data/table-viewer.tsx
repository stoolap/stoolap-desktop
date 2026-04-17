
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnectionStore } from "@/stores/connection-store";
import { useEditorStore } from "@/stores/editor-store";
import { useTableForeignKeys } from "@/hooks/use-schema";
import { DataGrid } from "@/components/results/data-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Table2,
  Filter,
  X,
  Trash2,
  FileOutput,
  FileInput,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import { cn, errorMessage, saveFile, escapeCSV } from "@/lib/utils";
import * as api from "@/lib/api-client";
import * as native from "@/lib/native";
import type { FilterCondition } from "@/lib/api-client";
import type { ColumnInfo } from "@/lib/types";
import { VectorSearchDialog } from "@/components/dialogs/vector-search-dialog";
import { RowEditorDialog } from "./row-editor";

const OPERATORS = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "like", label: "LIKE" },
  { value: "nlike", label: "NOT LIKE" },
  { value: "null", label: "IS NULL" },
  { value: "nnull", label: "IS NOT NULL" },
  { value: "in", label: "IN" },
];

const VECTOR_OPERATORS = [
  { value: "cosine", label: "Cosine dist <" },
  { value: "l2", label: "L2 dist <" },
  { value: "ip", label: "IP dist <" },
];

const NO_VALUE_OPS = new Set(["null", "nnull"]);
const VEC_OPS = new Set(["cosine", "l2", "ip"]);

interface FilterRow {
  id: number;
  column: string;
  operator: string;
  value: string;
}

let nextFilterId = 0;

function newFilter(column: string): FilterRow {
  return { id: ++nextFilterId, column, operator: "eq", value: "" };
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

interface TableViewerProps {
  table: string;
  columns: ColumnInfo[];
  initialFilter?: { column: string; value: string };
}

export function TableViewer({
  table,
  columns,
  initialFilter,
}: TableViewerProps) {
  const activeId = useConnectionStore((s) => s.activeId);
  const addDataTab = useEditorStore((s) => s.addDataTab);
  const { data: foreignKeys } = useTableForeignKeys(table);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDir, setOrderDir] = useState<"ASC" | "DESC">("ASC");
  const [insertOpen, setInsertOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filterRows, setFilterRows] = useState<FilterRow[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<FilterCondition[]>([]);
  const [deletingRow, setDeletingRow] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showTimeTravel, setShowTimeTravel] = useState(false);
  const [asOfTimestamp, setAsOfTimestamp] = useState("");
  const [appliedAsOf, setAppliedAsOf] = useState<string | undefined>();
  const [limit, setLimit] = useState(100);
  const [vecSearchOpen, setVecSearchOpen] = useState(false);
  const [vecSearchProps, setVecSearchProps] = useState<{
    column?: string;
    vector?: string;
  }>({});
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const vectorColumns = useMemo(() => {
    const set = new Set<string>();
    for (const c of columns) {
      if (c.type.toUpperCase().startsWith("VECTOR")) set.add(c.field);
    }
    return set;
  }, [columns]);

  // Apply initial filter from FK navigation
  useEffect(() => {
    if (initialFilter) {
      const f = newFilter(initialFilter.column);
      f.value = initialFilter.value;
      setFilterRows([f]);
      setAppliedFilters([
        {
          column: initialFilter.column,
          operator: "eq",
          value: initialFilter.value,
        },
      ]);
      setShowFilters(true);
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    data: rowsData,
    isLoading,
    error: fetchError,
    refetch: refetchRows,
  } = useQuery({
    queryKey: [
      "tableRows",
      activeId,
      table,
      offset,
      limit,
      orderBy,
      orderDir,
      appliedFilters,
      appliedAsOf,
    ],
    queryFn: () =>
      api.fetchTableRows(
        activeId!,
        table,
        offset,
        limit,
        orderBy,
        orderDir,
        appliedFilters.length > 0 ? appliedFilters : undefined,
        appliedAsOf,
      ),
    enabled: !!activeId,
  });

  // Count depends only on the filter/time-travel scope, NOT on offset/limit/sort.
  // Keeping it separate means paginating a filtered view doesn't re-run COUNT(*).
  const { data: countData, refetch: refetchCount } = useQuery({
    queryKey: [
      "tableRowCount",
      activeId,
      table,
      appliedFilters,
      appliedAsOf,
    ],
    queryFn: () =>
      api.fetchTableCount(
        activeId!,
        table,
        appliedFilters.length > 0 ? appliedFilters : undefined,
        appliedAsOf,
      ),
    enabled: !!activeId,
  });

  const data = useMemo(() => {
    if (!rowsData) return null;
    return {
      columns: rowsData.columns,
      rows: rowsData.rows,
      totalRows: countData?.totalRows ?? 0,
      time: rowsData.time,
    };
  }, [rowsData, countData]);

  const refetch = useCallback(async () => {
    await Promise.all([refetchRows(), refetchCount()]);
  }, [refetchRows, refetchCount]);

  const pkColumn = columns.find((c) => c.key === "PRI");

  const handleCellEdit = useCallback(
    async (rowIndex: number, colIndex: number, value: string) => {
      if (!activeId || !data || !pkColumn) return;
      const colName = data.columns[colIndex];
      // Skip inline edit for vector columns
      const colInfo = columns.find((c) => c.field === colName);
      if (colInfo?.type.toUpperCase().startsWith("VECTOR")) return;
      const pkIdx = data.columns.indexOf(pkColumn.field);
      if (pkIdx === -1) return;
      const pkValue = data.rows[rowIndex][pkIdx];
      try {
        await api.updateRow(activeId, table, pkColumn.field, pkValue, {
          [colName]: value === "" ? null : value,
        });
        refetch();
        toast.success("Row updated");
      } catch (e) {
        toast.error("Update failed", {
          description: errorMessage(e),
        });
      }
    },
    [activeId, data, pkColumn, table, columns, refetch],
  );

  const handleDeleteRow = useCallback(
    async (rowIndex: number) => {
      if (!activeId || !data || !pkColumn || deletingRow) return;
      const pkIdx = data.columns.indexOf(pkColumn.field);
      if (pkIdx === -1) return;
      const pkValue = data.rows[rowIndex]?.[pkIdx];

      const confirmed = await native.showConfirmDialog({
        title: "Delete Row",
        message: `Delete row with ${pkColumn.field} = ${pkValue}?`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;

      setDeletingRow(true);
      try {
        await api.deleteRow(activeId, table, pkColumn.field, pkValue);
        refetch();
        toast.success("Row deleted");
      } catch (e) {
        toast.error("Delete failed", {
          description: errorMessage(e),
        });
      } finally {
        setDeletingRow(false);
      }
    },
    [activeId, data, pkColumn, table, refetch, deletingRow],
  );

  const handleInsert = useCallback(
    async (row: Record<string, unknown>) => {
      if (!activeId) return;
      await api.insertRow(activeId, table, row);
      setOffset(0);
      refetch();
      queryClient.invalidateQueries({ queryKey: ["tableRows", activeId] });
      queryClient.invalidateQueries({ queryKey: ["tableRowCount", activeId] });
      toast.success("Row inserted");
    },
    [activeId, table, refetch, queryClient],
  );

  const handleServerSort = useCallback(
    (column: string, direction: "ASC" | "DESC") => {
      setOrderBy(column);
      setOrderDir(direction);
      setOffset(0);
    },
    [],
  );

  const handleNavigateFK = useCallback(
    (refTable: string, refColumn: string, value: unknown) => {
      addDataTab(refTable, {
        column: refColumn,
        value: String(value ?? ""),
      });
    },
    [addDataTab],
  );

  const handleFindSimilar = useCallback(
    (column: string, vectorValue: string) => {
      setVecSearchProps({ column, vector: vectorValue });
      setVecSearchOpen(true);
    },
    [],
  );

  const addFilter = () => {
    const firstCol = columns[0]?.field ?? "";
    const f = newFilter(firstCol);
    if (vectorColumns.has(firstCol)) f.operator = "cosine";
    setFilterRows((prev) => [...prev, f]);
    if (!showFilters) setShowFilters(true);
  };

  const updateFilter = (id: number, updates: Partial<FilterRow>) => {
    setFilterRows((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...updates } : f)),
    );
  };

  const removeFilter = (id: number) => {
    setFilterRows((prev) => prev.filter((f) => f.id !== id));
  };

  const applyFilters = () => {
    const valid = filterRows
      .filter((f) => {
        if (!f.column) return false;
        if (NO_VALUE_OPS.has(f.operator)) return true;
        if (VEC_OPS.has(f.operator)) {
          const pipeIdx = f.value.lastIndexOf("|");
          if (pipeIdx === -1) return false;
          return (
            f.value.substring(0, pipeIdx).trim() !== "" &&
            f.value.substring(pipeIdx + 1).trim() !== ""
          );
        }
        return f.value.trim() !== "";
      })
      .map((f) => ({
        column: f.column,
        operator: f.operator,
        value: f.value,
      }));
    setAppliedFilters(valid);
    setOffset(0);
  };

  const clearFilters = () => {
    setFilterRows([]);
    setAppliedFilters([]);
    setOffset(0);
  };

  const hasUnappliedChanges = useMemo(() => {
    const pending = filterRows
      .filter((f) => {
        if (!f.column) return false;
        if (NO_VALUE_OPS.has(f.operator)) return true;
        if (VEC_OPS.has(f.operator)) {
          const pipeIdx = f.value.lastIndexOf("|");
          if (pipeIdx === -1) return false;
          return (
            f.value.substring(0, pipeIdx).trim() !== "" &&
            f.value.substring(pipeIdx + 1).trim() !== ""
          );
        }
        return f.value.trim() !== "";
      })
      .map((f) => ({ column: f.column, operator: f.operator, value: f.value }));
    if (pending.length !== appliedFilters.length) return true;
    return pending.some(
      (p, i) =>
        p.column !== appliedFilters[i].column ||
        p.operator !== appliedFilters[i].operator ||
        p.value !== appliedFilters[i].value,
    );
  }, [filterRows, appliedFilters]);

  const handleExportCSV = () => {
    if (!data) return;
    const header = data.columns.map(escapeCSV).join(",");
    const rows = data.rows.map((r) => r.map(escapeCSV).join(","));
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    saveFile(
      [header, ...rows].join("\n"),
      `${table}_${ts}.csv`,
      "text/csv",
    );
  };

  const handleExportJSON = () => {
    if (!data) return;
    const objs = data.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      data.columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    saveFile(
      JSON.stringify(objs, null, 2),
      `${table}_${ts}.json`,
      "application/json",
    );
  };

  const handleExportAllCSV = async () => {
    if (!activeId) return;
    const PAGE_SIZE = 50_000;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    if (totalRows > 10_000) {
      const ok = await native.showConfirmDialog({
        title: "Export All Rows",
        message: `This will export ${totalRows.toLocaleString()} rows.`,
        detail: "Large exports may take a while.",
        confirmLabel: "Export",
      });
      if (!ok) return;
    }

    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const path = await save({
      defaultPath: `${table}_${ts}.csv`,
      filters: [{ name: "CSV Files", extensions: ["csv"] }],
    });
    if (!path) return;

    try {
      toast.info("Exporting...");
      const filters = appliedFilters.length > 0 ? appliedFilters : undefined;
      let totalExported = 0;
      let isFirst = true;

      for (let off = 0; off < totalRows; off += PAGE_SIZE) {
        const chunk = await api.fetchTableRows(
          activeId, table, off, PAGE_SIZE,
          orderBy, orderDir, filters, appliedAsOf,
        );
        let csvChunk = "";
        if (isFirst) {
          csvChunk = chunk.columns.map(escapeCSV).join(",") + "\n";
        }
        if (chunk.rows.length > 0) {
          csvChunk += chunk.rows.map((r) => r.map(escapeCSV).join(",")).join("\n") + "\n";
          totalExported += chunk.rows.length;
        }
        // Write to disk: first chunk creates file, rest append
        await writeTextFile(path, csvChunk, isFirst ? undefined : { append: true });
        isFirst = false;
        if (chunk.rows.length < PAGE_SIZE) break;
      }
      const msg = `Exported ${totalExported.toLocaleString()} rows`;
      native.notify("Export Complete", msg);
      toast.success(msg);
    } catch (e) {
      toast.error("Export failed", {
        description: errorMessage(e),
      });
    }
  };

  const handleImport = async () => {
    if (!activeId) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "CSV / JSON", extensions: ["csv", "json", "jsonl"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (typeof selected !== "string") return;

    const ext = selected.split(".").pop()?.toLowerCase() ?? "";
    const format = ext === "json" || ext === "jsonl" ? "json" : "csv";

    setImporting(true);
    try {
      const result = await api.importFile(activeId, table, selected, format, true);
      refetch();
      queryClient.invalidateQueries({ queryKey: ["tableRows", activeId] });
      queryClient.invalidateQueries({ queryKey: ["tableRowCount", activeId] });
      queryClient.invalidateQueries({ queryKey: ["rowcount", activeId] });
      const msg = `Imported ${result.rows} row${result.rows !== 1 ? "s" : ""} in ${result.time}ms`;
      native.notify("Import Complete", msg);
      toast.success(msg);
    } catch (e) {
      toast.error("Import failed", {
        description: errorMessage(e),
      });
    } finally {
      setImporting(false);
    }
  };

  const totalRows = data?.totalRows ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b panel-toolbar">
        <Table2 className="h-3.5 w-3.5 text-blue-400 shrink-0 ml-1" />
        <span className="text-sm font-medium mr-1">{table}</span>
        <div className="toolbar-separator" />
        <div className="flex-1" />
        <Button
          variant={showFilters ? "default" : "ghost"}
          size="sm"
          onClick={() => {
            if (showFilters && filterRows.length === 0) {
              setShowFilters(false);
            } else if (!showFilters) {
              if (filterRows.length === 0) addFilter();
              else setShowFilters(true);
            } else {
              setShowFilters(false);
            }
          }}
          className={cn(
            "gap-1",
            appliedFilters.length > 0 && !showFilters && "text-primary",
          )}
        >
          <Filter className="h-3.5 w-3.5" />
          Filter
          {appliedFilters.length > 0 && (
            <span className="ml-0.5 text-xs bg-primary/20 text-primary rounded-full px-1.5">
              {appliedFilters.length}
            </span>
          )}
        </Button>
        <Button
          variant={showTimeTravel ? "default" : "ghost"}
          size="sm"
          onClick={() => {
            setShowTimeTravel(!showTimeTravel);
            if (showTimeTravel && !asOfTimestamp) {
              setAppliedAsOf(undefined);
            }
          }}
          className={cn(
            "gap-1",
            appliedAsOf && !showTimeTravel && "text-amber-500",
          )}
        >
          <Clock className="h-3.5 w-3.5" />
          Time Travel
          {appliedAsOf && (
            <span className="ml-0.5 text-xs bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded-full px-1.5">
              ON
            </span>
          )}
        </Button>
        <div className="toolbar-separator" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setInsertOpen(true)}
          className="gap-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Insert
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleImport}
          disabled={importing}
          className="gap-1"
        >
          {importing ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileInput className="h-3.5 w-3.5" />
          )}
          {importing ? "Importing..." : "Import"}
        </Button>
        {data && data.rows.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                <FileOutput className="h-3.5 w-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={handleExportCSV}>
                Export Page as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportJSON}>
                Export Page as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportAllCSV}>
                Export All as CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={async () => { await refetch(); toast.success("Data refreshed"); }}
          aria-label="Refresh data"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Filter bar */}
      {showFilters && (
        <div className="border-b bg-muted/20 px-3 py-2 space-y-1.5">
          {filterRows.map((f) => {
            const isVec = vectorColumns.has(f.column);
            const isVecOp = VEC_OPS.has(f.operator);
            const ops = isVec ? VECTOR_OPERATORS : OPERATORS;
            return (
              <div key={f.id} className="flex items-center gap-2">
                {/* Column */}
                <Select
                  value={f.column}
                  onValueChange={(v) => {
                    const updates: Partial<FilterRow> = { column: v };
                    // Auto-switch operator when changing between vector and non-vector columns
                    if (vectorColumns.has(v) && !VEC_OPS.has(f.operator)) {
                      updates.operator = "cosine";
                      updates.value = "";
                    } else if (
                      !vectorColumns.has(v) &&
                      VEC_OPS.has(f.operator)
                    ) {
                      updates.operator = "eq";
                      updates.value = "";
                    }
                    updateFilter(f.id, updates);
                  }}
                >
                  <SelectTrigger className="w-[160px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c.field} value={c.field}>
                        <span className="font-data">{c.field}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Operator */}
                <Select
                  value={f.operator}
                  onValueChange={(v) => updateFilter(f.id, { operator: v })}
                >
                  <SelectTrigger
                    className={cn(
                      "w-[140px] h-8 text-sm",
                      isVecOp && "text-purple-500",
                    )}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((op) => (
                      <SelectItem key={op.value} value={op.value}>
                        {op.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Value — vector: two inputs (query vector + threshold) */}
                {isVecOp ? (
                  <div className="flex-1 flex gap-1.5">
                    <Input
                      placeholder="[0.1, 0.2, 0.3, ...]"
                      value={
                        f.value.substring(
                          0,
                          Math.max(0, f.value.lastIndexOf("|")),
                        ) || (f.value.includes("|") ? "" : f.value)
                      }
                      onChange={(e) => {
                        const pipeIdx = f.value.lastIndexOf("|");
                        const threshold =
                          pipeIdx !== -1 ? f.value.substring(pipeIdx + 1) : "";
                        updateFilter(f.id, {
                          value: `${e.target.value}|${threshold}`,
                        });
                      }}
                      className="flex-1 h-8 text-sm font-data text-purple-500"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyFilters();
                      }}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="max dist"
                      value={
                        f.value.includes("|")
                          ? f.value.substring(f.value.lastIndexOf("|") + 1)
                          : ""
                      }
                      onChange={(e) => {
                        const pipeIdx = f.value.lastIndexOf("|");
                        const vecPart =
                          pipeIdx !== -1
                            ? f.value.substring(0, pipeIdx)
                            : f.value;
                        updateFilter(f.id, {
                          value: `${vecPart}|${e.target.value}`,
                        });
                      }}
                      className="w-28 h-8 text-sm font-data"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyFilters();
                      }}
                    />
                  </div>
                ) : !NO_VALUE_OPS.has(f.operator) ? (
                  <Input
                    placeholder={
                      f.operator === "like"
                        ? "%pattern%"
                        : f.operator === "in"
                          ? "val1|val2|val3"
                          : "value"
                    }
                    value={f.value}
                    onChange={(e) =>
                      updateFilter(f.id, { value: e.target.value })
                    }
                    className="flex-1 h-8 text-sm font-data"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyFilters();
                    }}
                  />
                ) : (
                  <div className="flex-1" />
                )}

                {/* Remove */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeFilter(f.id)}
                  aria-label="Remove filter"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}

          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={addFilter}
              className="gap-1 h-7 text-xs"
            >
              <Plus className="h-3 w-3" />
              Add Condition
            </Button>
            <div className="flex-1" />
            {(filterRows.length > 0 || appliedFilters.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="gap-1 h-7 text-xs text-muted-foreground"
              >
                <Trash2 className="h-3 w-3" />
                Clear All
              </Button>
            )}
            <Button
              size="sm"
              onClick={applyFilters}
              disabled={filterRows.length === 0}
              className={cn(
                "gap-1 h-7 text-xs",
                hasUnappliedChanges && "animate-pulse",
              )}
            >
              <Filter className="h-3 w-3" />
              Apply
            </Button>
          </div>
        </div>
      )}

      {/* Time Travel bar */}
      {showTimeTravel && (
        <div className="border-b bg-amber-50/30 dark:bg-amber-950/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0">
              AS OF TIMESTAMP
            </span>
            <Input
              type="datetime-local"
              step="1"
              value={asOfTimestamp}
              onChange={(e) => setAsOfTimestamp(e.target.value)}
              className="h-7 w-[220px] text-xs font-data"
              onKeyDown={(e) => {
                if (e.key === "Enter" && asOfTimestamp) {
                  setAppliedAsOf(asOfTimestamp.replace("T", " "));
                  setOffset(0);
                }
              }}
            />
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={!asOfTimestamp}
              onClick={() => {
                setAppliedAsOf(asOfTimestamp.replace("T", " "));
                setOffset(0);
              }}
            >
              Apply
            </Button>
            {appliedAsOf && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1 text-muted-foreground"
                onClick={() => {
                  setAsOfTimestamp("");
                  setAppliedAsOf(undefined);
                  setOffset(0);
                }}
              >
                <X className="h-3 w-3" />
                Clear
              </Button>
            )}
            <div className="flex-1" />
            <span className="text-xs text-muted-foreground">
              View table data at a specific point in time
            </span>
          </div>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="p-3 text-xs text-muted-foreground">Loading...</div>
        ) : fetchError ? (
          <div className="p-3 text-xs text-destructive">
            Failed to load data:{" "}
            {errorMessage(fetchError)}
          </div>
        ) : data ? (
          <DataGrid
            columns={data.columns}
            rows={data.rows}
            columnTypes={columns.map((c) => c.type)}
            onCellEdit={pkColumn ? handleCellEdit : undefined}
            onDeleteRow={pkColumn ? handleDeleteRow : undefined}
            foreignKeys={foreignKeys}
            onNavigateToFK={handleNavigateFK}
            onFindSimilar={
              vectorColumns.size > 0 ? handleFindSimilar : undefined
            }
            serverSort={
              orderBy ? { column: orderBy, direction: orderDir } : undefined
            }
            onServerSort={handleServerSort}
          />
        ) : null}
      </div>

      {/* Pagination */}
      <div className="flex items-center gap-1 px-3 py-1 border-t panel-toolbar text-xs">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-muted-foreground tabular-nums">
          {data && data.rows.length > 0
            ? `Rows ${offset + 1}-${offset + data.rows.length} of ${totalRows}`
            : "No rows"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={!data || offset + limit >= totalRows}
          onClick={() => setOffset(offset + limit)}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <div className="toolbar-separator" />
        <Select
          value={String(limit)}
          onValueChange={(v) => {
            setLimit(Number(v));
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-6 w-20 text-xs border-0 bg-transparent shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[25, 50, 100, 250, 500].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {appliedFilters.length > 0 && (
          <span className="ml-2 text-primary text-xs">
            {appliedFilters.length} filter
            {appliedFilters.length !== 1 ? "s" : ""} active
          </span>
        )}
        {appliedAsOf && (
          <span className="ml-2 text-amber-500 text-xs flex items-center gap-1">
            <Clock className="h-3 w-3" />
            AS OF {appliedAsOf}
          </span>
        )}
      </div>


      <RowEditorDialog
        open={insertOpen}
        onOpenChange={setInsertOpen}
        columns={columns}
        onSave={handleInsert}
      />

      <VectorSearchDialog
        open={vecSearchOpen}
        onOpenChange={setVecSearchOpen}
        initialTable={table}
        initialColumn={vecSearchProps.column}
        initialVector={vecSearchProps.vector}
      />
    </div>
  );
}
