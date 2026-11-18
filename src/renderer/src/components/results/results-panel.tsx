
import { useEditorStore } from "@/stores/editor-store";
import { DataGrid } from "./data-grid";
import { ExplainView } from "@/components/explain/explain-view";
import { AlertCircle, CheckCircle2, PenLine, Sparkles, Table2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantStore } from "@/stores/assistant-store";
import { useModKey } from "@/hooks/use-mod-key";
import { cn } from "@/lib/utils";
import { isExplain } from "@/lib/sql-utils";

/**
 * A script's statements as tabs over the result, each labelled with what it
 * returned. Only shown when more than one statement ran.
 */
export function ResultsPanel() {
  const tab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
  const selectTabResult = useEditorStore((s) => s.selectTabResult);
  const results = tab?.results;
  if (!tab || !results || results.length < 2) return <ResultView />;
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        role="tablist"
        aria-label="Statement results"
        className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-muted/40 px-1.5 pt-1 scrollbar-none"
      >
        {results.map((r, i) => {
          const [Icon, detail] =
            "columns" in r
              ? [Table2, `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? "" : "s"}`]
              : "ddl" in r
                ? [CheckCircle2, r.ddl]
                : [PenLine, `${r.changes.toLocaleString()} changed`];
          const selected = i === tab.resultIndex;
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={selected}
              title={r.sql.replace(/\s+/g, " ").trim()}
              onClick={() => selectTabResult(tab.id, i)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 rounded-t-md border px-3 py-1.5 text-xs",
                selected
                  ? "border-border border-b-background bg-background font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("h-3.5 w-3.5", selected ? "text-primary" : "opacity-60")} />
              <span>
                Result #{i + 1}:{" "}
                <span className="font-normal text-muted-foreground">{detail}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-hidden">
        <ResultView />
      </div>
    </div>
  );
}

function ResultView() {
  const result = useEditorStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.result ?? null,
  );
  // The statement behind the result: its own in a script, else the run's SQL
  const lastExecutedSql = useEditorStore((s) => {
    const t = s.tabs.find((t) => t.id === s.activeTabId);
    return t?.results?.[t.resultIndex ?? -1]?.sql ?? t?.lastExecutedSql;
  });
  const mod = useModKey();

  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-1.5">
        <Terminal className="h-6 w-6 opacity-15" />
        <p className="text-xs text-muted-foreground/50">Run a query to see results</p>
        <p className="text-xs text-muted-foreground/30">
          {mod}+Enter to execute
        </p>
      </div>
    );
  }

  if ("error" in result && result.error) {
    return (
      <div className="p-4 flex items-start gap-2 overflow-auto h-full">
        <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="flex flex-col items-start gap-2">
          <pre className="text-sm text-destructive whitespace-pre-wrap font-data">
            {result.error}
          </pre>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => useAssistantStore.getState().ask("Fix the error in this query")}
          >
            <Sparkles className="h-3.5 w-3.5" /> Fix with assistant
          </Button>
        </div>
      </div>
    );
  }

  if ("columns" in result) {
    // Detect EXPLAIN by checking the SQL that was executed
    const explain =
      isExplain(lastExecutedSql ?? "") &&
      result.columns.length === 1 &&
      result.rows.length > 0;

    if (explain) {
      const planText = result.rows.map((r) => String(r[0] ?? "")).join("\n");
      return <ExplainView plan={planText} />;
    }

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {result.rows.length >= 10000 && (
          <div className="px-3 py-1 bg-amber-500/10 border-b text-xs text-amber-600 dark:text-amber-400 shrink-0">
            Large result set ({result.rows.length.toLocaleString()} rows).
            Consider adding LIMIT to your query for better performance.
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <DataGrid columns={result.columns} rows={result.rows} />
        </div>
      </div>
    );
  }

  if ("ddl" in result) {
    return (
      <div className="p-4 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        <span className="text-sm">
          {result.ddl} completed
          <span className="text-muted-foreground ml-1 tabular-nums">
            ({result.time}ms)
          </span>
        </span>
      </div>
    );
  }

  if ("changes" in result) {
    return (
      <div className="p-4 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        <span className="text-sm">
          {result.changes} row{result.changes !== 1 ? "s" : ""} affected
          <span className="text-muted-foreground ml-1 tabular-nums">
            ({result.time}ms)
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="p-4 flex items-center gap-2 text-muted-foreground">
      <CheckCircle2 className="h-4 w-4" />
      <span className="text-sm">Query executed successfully</span>
    </div>
  );
}
