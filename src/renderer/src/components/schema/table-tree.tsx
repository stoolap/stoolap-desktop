
import { useState, useMemo } from "react";
import {
  useTables,
  useViews,
  useTableColumns,
  useTableIndexes,
  useTableForeignKeys,
  useTableRowCount,
} from "@/hooks/use-schema";
import { useEditorStore } from "@/stores/editor-store";
import { useConnectionStore } from "@/stores/connection-store";
import { Input } from "@/components/ui/input";
import { CreateTableDialog } from "@/components/dialogs/create-table";
import { AlterTableDialog } from "@/components/dialogs/alter-table";
import { CreateViewDialog } from "@/components/dialogs/create-view";
import { CreateIndexDialog } from "@/components/dialogs/create-index";
import { VectorSearchDialog } from "@/components/dialogs/vector-search-dialog";
import {
  ChevronRight,
  ChevronDown,
  Table2,
  Eye,
  Columns3,
  Key,
  Hash,
  Link2,
  ArrowRight,
  RefreshCw,
  Plus,
  Search,
  Waypoints,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, errorMessage, quoteId } from "@/lib/utils";
import * as native from "@/lib/native";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as api from "@/lib/api-client";
import type { ColumnInfo, IndexInfo, ForeignKeyInfo } from "@/lib/types";

/** Build a valid example vector string from a VECTOR(N) type. */
function exampleVector(type: string): string {
  const m = type.match(/^VECTOR\((\d+)\)$/i);
  if (!m) return "[0.1]";
  const dims = parseInt(m[1], 10);
  if (dims <= 0) return "[0.1]";
  return "[" + Array(dims).fill("0.1").join(", ") + "]";
}

function ColumnItem({
  col,
  isForeignKey,
}: {
  col: ColumnInfo;
  isForeignKey?: boolean;
}) {
  const isVector = col.type.toUpperCase().startsWith("VECTOR");
  return (
    <div className="flex items-center gap-1.5 pl-7 pr-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 min-w-0 overflow-hidden">
      {col.key === "PRI" ? (
        <Key className="h-3 w-3 text-yellow-500 shrink-0" />
      ) : isForeignKey ? (
        <Link2 className="h-3 w-3 text-blue-400 shrink-0" />
      ) : isVector ? (
        <Waypoints className="h-3 w-3 text-purple-400 shrink-0" />
      ) : (
        <Columns3 className="h-3 w-3 shrink-0 opacity-40" />
      )}
      <span className="truncate font-data">{col.field}</span>
      <span className="ml-auto text-xs opacity-50 shrink-0 font-data">
        {col.type}
      </span>
      {isForeignKey && (
        <span className="text-xs text-blue-400 shrink-0 font-semibold">
          FK
        </span>
      )}
      {!col.nullable && (
        <span className="text-xs text-orange-400 shrink-0 font-semibold">
          NN
        </span>
      )}
    </div>
  );
}

function IndexItem({
  idx,
  tableName,
  colType,
  onDrop,
}: {
  idx: IndexInfo;
  tableName: string;
  colType?: string;
  onDrop: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const addTab = useEditorStore((s) => s.addTab);
  const isHnsw = idx.indexType.toUpperCase() === "HNSW";

  const handleQueryUsingIndex = () => {
    if (isHnsw) {
      const vec = colType ? exampleVector(colType) : "[0.1]";
      addTab(
        `k-NN: ${idx.columnName}`,
        `-- Replace the query vector with your own\nSELECT *, VEC_DISTANCE_COSINE(${quoteId(idx.columnName)}, '${vec}') AS distance\nFROM ${quoteId(tableName)}\nORDER BY distance\nLIMIT 10`,
      );
    } else {
      addTab(
        idx.indexName,
        `SELECT * FROM ${quoteId(tableName)} WHERE ${quoteId(idx.columnName)} = ?`,
      );
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const selected = await native.showContextMenu([
      {
        id: "query",
        label: isHnsw ? "k-NN Similarity Search" : "Query Using Index",
      },
      { id: "sep", label: "", type: "separator" },
      { id: "drop", label: "Drop Index" },
    ]);
    if (selected === "query") handleQueryUsingIndex();
    if (selected === "drop") onDrop();
  };

  return (
    <div className="overflow-hidden">
      <div
        className="flex items-center gap-1.5 pl-7 pr-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 cursor-pointer select-none min-w-0 overflow-hidden"
        onClick={() => setExpanded(!expanded)}
        onContextMenu={handleContextMenu}
      >
        {expanded ? (
          <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-40" />
        ) : (
          <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-40" />
        )}
        {isHnsw ? (
          <Waypoints className="h-2.5 w-2.5 shrink-0 text-purple-400" />
        ) : (
          <Hash className="h-2.5 w-2.5 shrink-0 opacity-40" />
        )}
        <span className="truncate font-data">{idx.indexName}</span>
        {idx.isUnique && (
          <span className="text-xs text-yellow-500 shrink-0 font-semibold">
            UQ
          </span>
        )}
        <span
          className={cn(
            "ml-auto text-xs shrink-0 font-data",
            isHnsw ? "text-purple-400" : "opacity-50",
          )}
        >
          {idx.indexType}
        </span>
      </div>
      {expanded && (
        <div className="pl-14 pr-2 py-0.5 space-y-0.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="opacity-50 w-14">Column:</span>
            <span className="font-data">{idx.columnName}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="opacity-50 w-14">Type:</span>
            <span className={cn("font-data", isHnsw && "text-purple-400")}>
              {idx.indexType}
            </span>
          </div>
          {!isHnsw && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="opacity-50 w-14">Unique:</span>
              <span className="font-data">{idx.isUnique ? "Yes" : "No"}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ForeignKeyItem({ fk }: { fk: ForeignKeyInfo }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden">
      <div
        className="flex items-center gap-1.5 pl-7 pr-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 cursor-pointer select-none min-w-0 overflow-hidden"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-40" />
        ) : (
          <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-40" />
        )}
        <Link2 className="h-2.5 w-2.5 shrink-0 text-blue-400" />
        <span className="truncate font-data">{fk.columnName}</span>
        <ArrowRight className="h-2.5 w-2.5 shrink-0 opacity-40" />
        <span className="truncate font-data text-blue-400">
          {fk.referencedTable}.{fk.referencedColumn}
        </span>
      </div>
      {expanded && (
        <div className="pl-14 pr-2 py-0.5 space-y-0.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="opacity-50 w-20">On Delete:</span>
            <span className="font-data">{fk.onDelete}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="opacity-50 w-20">On Update:</span>
            <span className="font-data">{fk.onUpdate}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TableNode({
  name,
  type,
  onRefresh,
}: {
  name: string;
  type: "table" | "view";
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [alterOpen, setAlterOpen] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const [vecSearchOpen, setVecSearchOpen] = useState(false);
  const needsColumns = expanded || alterOpen || indexOpen;
  const { data: columns } = useTableColumns(needsColumns ? name : null, type);
  const { data: indexes } = useTableIndexes(
    expanded && type === "table" ? name : null,
  );
  const { data: foreignKeys } = useTableForeignKeys(
    expanded && type === "table" ? name : null,
  );
  const fkColumns = new Set(foreignKeys?.map((fk) => fk.columnName) ?? []);
  const { data: rowCount } = useTableRowCount(type === "table" ? name : null);
  const addTab = useEditorStore((s) => s.addTab);
  const addDataTab = useEditorStore((s) => s.addDataTab);
  const activeId = useConnectionStore((s) => s.activeId);
  const queryClient = useQueryClient();

  const handleDoubleClick = () => {
    if (type === "table") {
      addDataTab(name);
    } else {
      addTab(name, `SELECT * FROM ${quoteId(name)} LIMIT 100`);
    }
  };

  const handleViewData = () => addDataTab(name);

  const handleSelectQuery = () => {
    addTab(name, `SELECT * FROM ${quoteId(name)} LIMIT 100`);
  };

  const handleShowDDL = async () => {
    if (!activeId) return;
    try {
      const ddl = await api.fetchDDL(activeId, name, type);
      addTab(`DDL: ${name}`, ddl);
    } catch (e) {
      toast.error("Failed to fetch DDL", {
        description: errorMessage(e),
      });
    }
  };

  const doTruncateTable = async () => {
    if (!activeId) return;
    try {
      await api.executeQuery(activeId, `TRUNCATE TABLE ${quoteId(name)}`);
      queryClient.invalidateQueries({ queryKey: ["tableRows"] });
      queryClient.invalidateQueries({ queryKey: ["tableRowCount"] });
      queryClient.invalidateQueries({ queryKey: ["rowcount"] });
      toast.success(`Table "${name}" truncated`);
    } catch (e) {
      toast.error("Failed to truncate table", {
        description: errorMessage(e),
      });
    }
  };

  const doDropTable = async () => {
    if (!activeId) return;
    try {
      const sql =
        type === "table"
          ? `DROP TABLE ${quoteId(name)}`
          : `DROP VIEW ${quoteId(name)}`;
      await api.executeQuery(activeId, sql);
      onRefresh();
      toast.success(`${type === "table" ? "Table" : "View"} "${name}" dropped`);
    } catch (e) {
      toast.error(`Failed to drop ${type}`, {
        description: errorMessage(e),
      });
    }
  };

  const doDropIndex = async (indexName: string) => {
    if (!activeId) return;
    try {
      await api.executeQuery(
        activeId,
        `DROP INDEX ${quoteId(indexName)} ON ${quoteId(name)}`,
      );
      queryClient.invalidateQueries({ queryKey: ["indexes"] });
      toast.success(`Index "${indexName}" dropped`);
    } catch (e) {
      toast.error("Failed to drop index", {
        description: errorMessage(e),
      });
    }
  };

  const handleInsertRow = () => {
    addTab(
      `Insert: ${name}`,
      columns
        ? `INSERT INTO ${quoteId(name)} (${columns.map((c) => quoteId(c.field)).join(", ")})\nVALUES (${columns.map((c, i) => `$${i + 1} /* ${c.type} */`).join(", ")})`
        : `INSERT INTO ${quoteId(name)} VALUES ()`,
    );
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const hasVectorCols = columns?.some((c) =>
      c.type.toUpperCase().startsWith("VECTOR"),
    );

    const items: Array<{
      id: string;
      label: string;
      type?: "separator" | "normal";
      enabled?: boolean;
    }> = [];

    if (type === "table") {
      items.push({ id: "viewData", label: "View Data" });
    }
    items.push({ id: "select", label: `SELECT * FROM ${name}` });
    items.push({ id: "ddl", label: "Show DDL" });

    if (type === "table") {
      items.push({ id: "sep1", label: "", type: "separator" });
      if (hasVectorCols) {
        items.push({ id: "vecSearch", label: "Vector Similarity Search" });
      }
      items.push({ id: "insert", label: "Insert Row" });
      items.push({ id: "createIndex", label: "Create Index" });
      items.push({ id: "editTable", label: "Edit Table" });
    }

    items.push({ id: "sep2", label: "", type: "separator" });
    if (type === "table") {
      items.push({ id: "truncate", label: "Truncate Table" });
    }
    items.push({
      id: "drop",
      label: `Drop ${type === "table" ? "Table" : "View"}`,
    });

    const selected = await native.showContextMenu(items);

    switch (selected) {
      case "viewData":
        handleViewData();
        break;
      case "select":
        handleSelectQuery();
        break;
      case "ddl":
        handleShowDDL();
        break;
      case "vecSearch":
        setVecSearchOpen(true);
        break;
      case "insert":
        handleInsertRow();
        break;
      case "createIndex":
        setIndexOpen(true);
        break;
      case "editTable":
        setAlterOpen(true);
        break;
      case "truncate": {
        const confirmed = await native.showConfirmDialog({
          title: "Truncate Table",
          message: `Are you sure you want to delete all rows from "${name}"?`,
          detail: "This cannot be undone.",
          confirmLabel: "Truncate",
          destructive: true,
        });
        if (confirmed) doTruncateTable();
        break;
      }
      case "drop": {
        const label = type === "table" ? "Table" : "View";
        const confirmed = await native.showConfirmDialog({
          title: `Drop ${label}`,
          message: `Are you sure you want to drop ${type} "${name}"?`,
          detail: "This cannot be undone.",
          confirmLabel: `Drop ${label}`,
          destructive: true,
        });
        if (confirmed) doDropTable();
        break;
      }
    }
  };

  const handleDropIndex = async (indexName: string) => {
    const confirmed = await native.showConfirmDialog({
      title: "Drop Index",
      message: `Are you sure you want to drop index "${indexName}"?`,
      confirmLabel: "Drop Index",
      destructive: true,
    });
    if (confirmed) doDropIndex(indexName);
  };

  return (
    <div className="overflow-hidden">
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-accent text-xs select-none min-w-0 overflow-hidden",
        )}
        onClick={() => setExpanded(!expanded)}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
        )}
        {type === "table" ? (
          <Table2 className="h-3 w-3 text-blue-400 shrink-0" />
        ) : (
          <Eye className="h-3 w-3 text-purple-400 shrink-0" />
        )}
        <span className="truncate" title={name}>
          {name}
        </span>
        {type === "table" && rowCount !== undefined && (
          <span className="ml-auto text-xs text-muted-foreground/40 tabular-nums shrink-0 pr-0.5">
            {rowCount.toLocaleString()}
          </span>
        )}
      </div>

      {expanded && (
        <div className="overflow-hidden">
          {columns?.map((col) => (
            <ColumnItem
              key={col.field}
              col={col}
              isForeignKey={fkColumns.has(col.field)}
            />
          ))}
          {foreignKeys && foreignKeys.length > 0 && (
            <>
              <div className="pl-5 pr-2 pt-1.5 pb-0.5 text-xs text-muted-foreground/40 uppercase tracking-widest font-semibold">
                Foreign Keys
              </div>
              {foreignKeys.map((fk) => (
                <ForeignKeyItem key={fk.columnName} fk={fk} />
              ))}
            </>
          )}
          {indexes && indexes.length > 0 && (
            <>
              <div className="pl-5 pr-2 pt-1.5 pb-0.5 text-xs text-muted-foreground/40 uppercase tracking-widest font-semibold">
                Indexes
              </div>
              {indexes.map((idx) => {
                const col = columns?.find((c) => c.field === idx.columnName);
                return (
                  <IndexItem
                    key={idx.indexName}
                    idx={idx}
                    tableName={name}
                    colType={col?.type}
                    onDrop={() => handleDropIndex(idx.indexName)}
                  />
                );
              })}
            </>
          )}
        </div>
      )}

      {type === "table" && columns && (
        <>
          <AlterTableDialog
            open={alterOpen}
            onOpenChange={setAlterOpen}
            table={name}
            columns={columns}
            onAltered={onRefresh}
          />
          <CreateIndexDialog
            open={indexOpen}
            onOpenChange={setIndexOpen}
            table={name}
            columns={columns}
            onCreated={() => {
              queryClient.invalidateQueries({ queryKey: ["indexes"] });
            }}
          />
        </>
      )}

      <VectorSearchDialog
        open={vecSearchOpen}
        onOpenChange={setVecSearchOpen}
        initialTable={name}
      />
    </div>
  );
}

export function TableTree() {
  const activeId = useConnectionStore((s) => s.activeId);
  const {
    data: tables,
    isLoading: tablesLoading,
    isFetching: tablesFetching,
  } = useTables();
  const {
    data: views,
    isLoading: viewsLoading,
    isFetching: viewsFetching,
  } = useViews();
  const isRefreshing = tablesFetching || viewsFetching;
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [createViewOpen, setCreateViewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tables", activeId] }),
      queryClient.invalidateQueries({ queryKey: ["views", activeId] }),
      queryClient.invalidateQueries({ queryKey: ["columns"] }),
      queryClient.invalidateQueries({ queryKey: ["indexes"] }),
      queryClient.invalidateQueries({ queryKey: ["fks"] }),
      queryClient.invalidateQueries({ queryKey: ["rowcount"] }),
    ]);
    toast.success("Schema refreshed");
  };

  const filteredTables = useMemo(() => {
    if (!tables) return [];
    if (!search) return tables;
    const q = search.toLowerCase();
    return tables.filter((t) => t.toLowerCase().includes(q));
  }, [tables, search]);

  const filteredViews = useMemo(() => {
    if (!views) return [];
    if (!search) return views;
    const q = search.toLowerCase();
    return views.filter((v) => v.toLowerCase().includes(q));
  }, [views, search]);

  if (!activeId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm p-4 text-center">
        <p>No connection</p>
        <p className="text-xs mt-1">Open a database to browse its schema</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/30">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/50">
          Schema
        </span>
        <div className="flex gap-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setCreateTableOpen(true)}
            title="Create Table"
            aria-label="Create Table"
          >
            <Plus className="h-2.5 w-2.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setCreateViewOpen(true)}
            title="Create View"
            aria-label="Create View"
          >
            <Eye className="h-2.5 w-2.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh schema"
          >
            <RefreshCw
              className={cn("h-2.5 w-2.5", isRefreshing && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <div className="px-1.5 py-1 border-b border-border/30">
        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/40" />
          <Input
            placeholder="Filter tables..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-6 pl-6 text-xs border-0 bg-muted/30 shadow-none focus-visible:ring-1"
            aria-label="Filter tables and views"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-auto-hide">
        {tablesLoading || viewsLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="py-0.5">
            {filteredTables.length > 0 && (
              <>
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground/40">
                  Tables ({filteredTables.length}
                  {search && tables ? `/${tables.length}` : ""})
                </div>
                {filteredTables.map((t) => (
                  <TableNode
                    key={t}
                    name={t}
                    type="table"
                    onRefresh={refresh}
                  />
                ))}
              </>
            )}
            {filteredViews.length > 0 && (
              <>
                <div className="px-3 py-1.5 mt-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                  Views ({filteredViews.length}
                  {search && views ? `/${views.length}` : ""})
                </div>
                {filteredViews.map((v) => (
                  <TableNode key={v} name={v} type="view" onRefresh={refresh} />
                ))}
              </>
            )}
            {filteredTables.length === 0 && filteredViews.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground text-center">
                {search ? "No matches" : "No tables yet"}
              </div>
            )}
          </div>
        )}
      </div>

      <CreateTableDialog
        open={createTableOpen}
        onOpenChange={setCreateTableOpen}
        onCreated={refresh}
      />
      <CreateViewDialog
        open={createViewOpen}
        onOpenChange={setCreateViewOpen}
        onCreated={refresh}
      />
    </div>
  );
}
