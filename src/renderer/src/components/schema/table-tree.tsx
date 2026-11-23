
import { useState, useMemo, useRef, useCallback, useLayoutEffect, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  useTables,
  useViews,
  useTableColumns,
  columnsQuery,
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
import { cn, errorMessage, middleCut, quoteId } from "@/lib/utils";
import { locale } from "@/lib/i18n";
import * as native from "@/lib/native";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as api from "@/lib/api-client";
import type { ColumnInfo, IndexInfo, ForeignKeyInfo } from "@/lib/types";
import { Tip } from "@/components/ui/tip";
import { indexQuery } from "@/lib/sql-utils";
import { generateTableIndexes } from "@/lib/sql-dump";

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
      <Tip label={col.field} side="bottom" delay={700}>
        <MiddleTruncate text={col.field} className="font-data" />
      </Tip>
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

let measureContext: CanvasRenderingContext2D | null = null;

/**
 * A name cut in the middle, as Finder does (see middleCut), measured in its
 * own font so the cut fills its room exactly. It takes the row's free width.
 */
function MiddleTruncate({ text, className, ref, ...props }: { text: string } & ComponentProps<"span">) {
  const own = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(text);
  // Its own ref, and the one a tooltip around it passes
  const setRef = useCallback(
    (node: HTMLSpanElement | null) => {
      own.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    const fit = () => {
      measureContext ??= document.createElement("canvas").getContext("2d");
      const ctx = measureContext;
      if (!ctx) return setShown(text);
      ctx.font = getComputedStyle(el).font;
      const width = el.clientWidth;
      setShown(middleCut(text, (s) => ctx.measureText(s).width <= width));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return (
    <span ref={setRef} className={cn("min-w-0 flex-1 overflow-hidden whitespace-nowrap", className)} {...props}>
      {shown}
    </span>
  );
}

function IndexItem({
  idx,
  tableName,
  tableColumns,
  onDrop,
}: {
  idx: IndexInfo;
  tableName: string;
  /** The table's columns, for the indexed ones' types */
  tableColumns?: ColumnInfo[];
  onDrop: () => void;
}) {
  const { t } = useTranslation("schema");
  const [expanded, setExpanded] = useState(false);
  const addTab = useEditorStore((s) => s.addTab);
  const isHnsw = idx.indexType.toUpperCase() === "HNSW";
  const typeOf = (column: string) => tableColumns?.find((c) => c.field === column)?.type;
  // An HNSW index is on one vector column
  const colType = typeOf(idx.columns[0] ?? idx.columnName);

  const handleQueryUsingIndex = () => {
    if (isHnsw) {
      const vec = colType ? exampleVector(colType) : "[0.1]";
      // The index's own metric, so the query can use it ("metric=l2, m=16, …")
      const metric = /metric=(\w+)/i.exec(idx.options ?? "")?.[1]?.toUpperCase() ?? "COSINE";
      const fn = ["L2", "COSINE", "IP"].includes(metric) ? `VEC_DISTANCE_${metric}` : "VEC_DISTANCE_COSINE";
      addTab(
        t("tableTree.tabKnn", { column: idx.columnName }),
        `-- Replace the query vector with your own\nSELECT *, ${fn}(${quoteId(idx.columnName)}, '${vec}') AS distance\nFROM ${quoteId(tableName)}\nORDER BY distance\nLIMIT 10`,
      );
    } else {
      addTab(idx.indexName, indexQuery(tableName, idx.indexName, idx.columns, typeOf));
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const selected = await native.showContextMenu([
      {
        id: "query",
        label: isHnsw ? t("tableTree.knnSearch") : t("tableTree.queryUsingIndex"),
      },
      { id: "sep", label: "", type: "separator" },
      { id: "drop", label: t("tableTree.dropIndex") },
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
        <Tip label={idx.indexName} side="bottom" delay={700}>
          <MiddleTruncate text={idx.indexName} className="font-data" />
        </Tip>
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
            <span className="opacity-50 w-14">{t("tableTree.column")}</span>
            <span className="font-data">{idx.columnName}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="opacity-50 w-14">{t("tableTree.type")}</span>
            <span className={cn("font-data", isHnsw && "text-purple-400")}>
              {idx.indexType}
            </span>
          </div>
          {!isHnsw && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="opacity-50 w-14">{t("tableTree.unique")}</span>
              <span className="font-data">{idx.isUnique ? t("tableTree.yes") : t("tableTree.no")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ForeignKeyItem({ fk }: { fk: ForeignKeyInfo }) {
  const { t } = useTranslation("schema");
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
            <span className="opacity-50 w-20">{t("tableTree.onDelete")}</span>
            <span className="font-data">{fk.onDelete}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="opacity-50 w-20">{t("tableTree.onUpdate")}</span>
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
  const { t } = useTranslation("schema");
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
      // The table's indexes too, as a backup writes them: without them the
      // DDL would rebuild the table without its indexes
      const indexes = type === "table" ? generateTableIndexes(name, await api.fetchIndexes(activeId, name)) : "";
      addTab(t("tableTree.tabDdl", { name }), indexes ? `${ddl};\n\n${indexes}` : ddl);
    } catch (e) {
      toast.error(t("tableTree.ddlFailed"), {
        description: errorMessage(e),
      });
    }
  };

  const doTruncateTable = async () => {
    if (!activeId) return;
    try {
      await api.runSql(activeId, `TRUNCATE TABLE ${quoteId(name)}`);
      queryClient.invalidateQueries({ queryKey: ["tableRows"] });
      queryClient.invalidateQueries({ queryKey: ["tableRowCount"] });
      queryClient.invalidateQueries({ queryKey: ["rowcount"] });
      toast.success(t("tableTree.truncated", { name }));
    } catch (e) {
      toast.error(t("tableTree.truncateFailed"), {
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
      await api.runSql(activeId, sql);
      onRefresh();
      toast.success(t(type === "table" ? "tableTree.tableDropped" : "tableTree.viewDropped", { name }));
    } catch (e) {
      toast.error(t(type === "table" ? "tableTree.dropTableFailed" : "tableTree.dropViewFailed"), {
        description: errorMessage(e),
      });
    }
  };

  const doDropIndex = async (indexName: string) => {
    if (!activeId) return;
    try {
      await api.runSql(
        activeId,
        `DROP INDEX ${quoteId(indexName)} ON ${quoteId(name)}`,
      );
      queryClient.invalidateQueries({ queryKey: ["indexes"] });
      toast.success(t("tableTree.indexDropped", { name: indexName }));
    } catch (e) {
      toast.error(t("tableTree.dropIndexFailed"), {
        description: errorMessage(e),
      });
    }
  };

  const handleInsertRow = (cols = columns) => {
    addTab(
      t("tableTree.tabInsert", { name }),
      cols
        ? `INSERT INTO ${quoteId(name)} (${cols.map((c) => quoteId(c.field)).join(", ")})\nVALUES (${cols.map((c, i) => `$${i + 1} /* ${c.type} */`).join(", ")})`
        : `INSERT INTO ${quoteId(name)} VALUES ()`,
    );
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // The columns are loaded when the table is opened; one never opened reads
    // them now, for its vector search item and its Insert Row template
    const cols =
      columns ??
      (activeId
        ? await queryClient.fetchQuery(columnsQuery(activeId, name, type)).catch(() => undefined)
        : undefined);
    const hasVectorCols = cols?.some((c) =>
      c.type.toUpperCase().startsWith("VECTOR"),
    );

    const items: Array<{
      id: string;
      label: string;
      type?: "separator" | "normal";
      enabled?: boolean;
    }> = [];

    if (type === "table") {
      items.push({ id: "viewData", label: t("tableTree.viewData") });
    }
    items.push({ id: "select", label: `SELECT * FROM ${name}` });
    items.push({ id: "ddl", label: t("tableTree.showDdl") });

    if (type === "table") {
      items.push({ id: "sep1", label: "", type: "separator" });
      if (hasVectorCols) {
        items.push({ id: "vecSearch", label: t("tableTree.vectorSearch") });
      }
      items.push({ id: "insert", label: t("tableTree.insertRow") });
      items.push({ id: "createIndex", label: t("tableTree.createIndex") });
      items.push({ id: "editTable", label: t("tableTree.editTable") });
    }

    items.push({ id: "sep2", label: "", type: "separator" });
    if (type === "table") {
      items.push({ id: "truncate", label: t("tableTree.truncateTable") });
    }
    items.push({
      id: "drop",
      label: t(type === "table" ? "tableTree.dropTable" : "tableTree.dropView"),
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
        handleInsertRow(cols);
        break;
      case "createIndex":
        setIndexOpen(true);
        break;
      case "editTable":
        setAlterOpen(true);
        break;
      case "truncate": {
        const confirmed = await native.showConfirmDialog({
          title: t("tableTree.truncateTable"),
          message: t("tableTree.confirmTruncate", { name }),
          detail: t("tableTree.cannotUndo"),
          confirmLabel: t("tableTree.truncate"),
          destructive: true,
        });
        if (confirmed) doTruncateTable();
        break;
      }
      case "drop": {
        const label = t(type === "table" ? "tableTree.dropTable" : "tableTree.dropView");
        const confirmed = await native.showConfirmDialog({
          title: label,
          message: t(type === "table" ? "tableTree.confirmDropTable" : "tableTree.confirmDropView", { name }),
          detail: t("tableTree.cannotUndo"),
          confirmLabel: label,
          destructive: true,
        });
        if (confirmed) doDropTable();
        break;
      }
    }
  };

  const handleDropIndex = async (indexName: string) => {
    const confirmed = await native.showConfirmDialog({
      title: t("tableTree.dropIndex"),
      message: t("tableTree.confirmDropIndex", { name: indexName }),
      confirmLabel: t("tableTree.dropIndex"),
      destructive: true,
    });
    if (confirmed) doDropIndex(indexName);
  };

  return (
    <div className="overflow-hidden">
      <div
        className={cn(
          // A pill inset from the edges, as macOS' sidebars have
          "mx-2 flex items-center gap-2 rounded-lg px-2 py-1 cursor-pointer hover:bg-accent text-sm select-none min-w-0 overflow-hidden",
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
          <Table2 className="h-4 w-4 text-foreground/80 shrink-0" />
        ) : (
          <Eye className="h-4 w-4 text-foreground/80 shrink-0" />
        )}
        <Tip label={name} side="bottom" delay={700}>
          <MiddleTruncate text={name} />
        </Tip>
        {type === "table" && rowCount !== undefined && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0 pr-0.5">
            {rowCount.toLocaleString(locale())}
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
              <div className="pl-5 pr-2 pt-1.5 pb-0.5 sidebar-heading text-xs font-semibold text-muted-foreground">
                {t("tableTree.foreignKeys")}
              </div>
              {foreignKeys.map((fk) => (
                <ForeignKeyItem key={fk.columnName} fk={fk} />
              ))}
            </>
          )}
          {indexes && indexes.length > 0 && (
            <>
              <div className="pl-5 pr-2 pt-1.5 pb-0.5 sidebar-heading text-xs font-semibold text-muted-foreground">
                {t("tableTree.indexes")}
              </div>
              {indexes.map((idx) => {
                return (
                  <IndexItem
                    key={idx.indexName}
                    idx={idx}
                    tableName={name}
                    tableColumns={columns}
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
  const { t } = useTranslation("schema");
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
        <p>{t("tableTree.noConnection")}</p>
        <p className="text-xs mt-1">{t("tableTree.noConnectionHint")}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between pl-4 pr-2.5 py-1">
        <span className="sidebar-heading text-xs font-semibold text-muted-foreground">
          {t("tableTree.schema")}
        </span>
        <div className="flex gap-0">
          <Tip label={t("tableTree.createTable")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCreateTableOpen(true)}
              aria-label={t("tableTree.createTable")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Tip label={t("tableTree.createView")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCreateViewOpen(true)}
              aria-label={t("tableTree.createView")}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Tip label={t("tableTree.refresh")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={refresh}
              aria-label={t("tableTree.refreshSchema")}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </Button>
          </Tip>
        </div>
      </div>

      <div className="px-2 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={t("tableTree.filterPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="sidebar-field h-8 pl-8 text-xs border-0 shadow-none focus-visible:ring-1"
            aria-label={t("tableTree.filterLabel")}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-auto-hide">
        {tablesLoading || viewsLoading ? (
          <div className="p-4 text-sm text-muted-foreground">{t("tableTree.loading")}</div>
        ) : (
          <div className="py-0.5">
            {filteredTables.length > 0 && (
              <>
                <div className="px-4 pt-2 pb-1 sidebar-heading text-xs font-semibold text-muted-foreground">
                  {t("tableTree.tables", {
                    shown: search && tables ? `${filteredTables.length}/${tables.length}` : filteredTables.length,
                  })}
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
                <div className="px-4 pt-3 pb-1 sidebar-heading text-xs font-semibold text-muted-foreground">
                  {t("tableTree.views", {
                    shown: search && views ? `${filteredViews.length}/${views.length}` : filteredViews.length,
                  })}
                </div>
                {filteredViews.map((v) => (
                  <TableNode key={v} name={v} type="view" onRefresh={refresh} />
                ))}
              </>
            )}
            {filteredTables.length === 0 && filteredViews.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground text-center">
                {search ? t("tableTree.noMatches") : t("tableTree.noTables")}
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
