import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Table2, Columns3 } from "lucide-react";
import { cn } from "@/lib/utils";

/** What to suggest while the user types */
export interface ComposerHints {
  /** Earlier requests, most recent first: ↑/↓ recall them, and they complete what is typed */
  history: string[];
  /** Requests that fit the open tab and database, also offered as completions */
  prompts: string[];
  /** Table -> column names, for @ mentions and completing names */
  schema?: Record<string, string[]>;
}

interface Mention {
  /** Where the @ is */
  start: number;
  query: string;
}

interface Option {
  label: string;
  kind: "table" | "column";
  /** The table a column belongs to */
  table?: string;
}

const MAX_OPTIONS = 8;
const TEXT = "block w-full px-2.5 py-2 text-sm whitespace-pre-wrap break-words";

/** The mention being typed just before the caret, if any */
function mentionAt(value: string, caret: number): Mention | null {
  const m = /(^|\s)@([\w.]*)$/.exec(value.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

export function mentionOptions(schema: Record<string, string[]> | undefined, query: string): Option[] {
  if (!schema) return [];
  const q = query.toLowerCase();
  const dot = q.indexOf(".");
  const out: Option[] = [];
  if (dot >= 0) {
    // table.col: the columns of that table
    const table = Object.keys(schema).find((t) => t.toLowerCase() === q.slice(0, dot));
    for (const c of table ? schema[table] : []) {
      if (c.toLowerCase().startsWith(q.slice(dot + 1))) out.push({ label: c, kind: "column", table });
    }
    return out.slice(0, MAX_OPTIONS);
  }
  for (const t of Object.keys(schema)) {
    if (t.toLowerCase().startsWith(q)) out.push({ label: t, kind: "table" });
  }
  if (q) {
    for (const [t, cols] of Object.entries(schema)) {
      for (const c of cols) {
        if (c.toLowerCase().startsWith(q)) out.push({ label: c, kind: "column", table: t });
      }
    }
  }
  return out.slice(0, MAX_OPTIONS);
}

/**
 * The rest of what the user is probably typing: an earlier or suggested
 * request it begins, else a table or column name its last word begins.
 */
export function completion(value: string, hints: ComposerHints): string {
  if (!value.trim()) return "";
  const lower = value.toLowerCase();
  for (const p of [...hints.history, ...hints.prompts]) {
    if (p.length > value.length && p.toLowerCase().startsWith(lower)) return p.slice(value.length);
  }
  const word = /([A-Za-z_][\w]*)$/.exec(value)?.[1];
  if (!word || word.length < 2 || !hints.schema) return "";
  const w = word.toLowerCase();
  const names = [...Object.keys(hints.schema), ...Object.values(hints.schema).flat()];
  const name = names.find((n) => n.length > word.length && n.toLowerCase().startsWith(w));
  return name ? name.slice(word.length) : "";
}

export interface ComposerHandle {
  focus: () => void;
}

/**
 * The assistant's message box: Enter sends; ↑/↓ on the first or last line
 * step through earlier requests; a faint completion is taken with Tab (or →
 * at the end); @ lists tables and columns to insert.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    hints: ComposerHints;
    placeholder?: string;
  }
>(function Composer({ value, onChange, onSubmit, hints, placeholder }, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  /** Position in the history while recalling, and the draft it replaced */
  const [recall, setRecall] = useState<{ index: number; draft: string } | null>(null);
  const [selected, setSelected] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }));

  const mention = mentionClosed ? null : mentionAt(value, caret);
  const options = useMemo(
    () => (mention ? mentionOptions(hints.schema, mention.query) : []),
    [mention?.query, hints.schema], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const atEnd = caret === value.length;
  const ghost = !mention && atEnd && recall === null ? completion(value, hints) : "";

  const set = (next: string, nextCaret = next.length) => {
    onChange(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextCaret, nextCaret));
  };

  const insertMention = (option: Option) => {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const text = `${option.label} `;
    set(before + text + after, before.length + text.length);
    setSelected(0);
  };

  const step = (direction: 1 | -1) => {
    const index = (recall?.index ?? -1) + direction;
    if (index < 0) {
      // Back past the newest: the draft as it was
      if (recall) set(recall.draft);
      setRecall(null);
      return;
    }
    if (index >= hints.history.length) return;
    setRecall({ index, draft: recall?.draft ?? value });
    set(hints.history[index]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if (options.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = options.length;
        setSelected((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(options[Math.min(selected, options.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionClosed(true);
        return;
      }
    }
    if (ghost && (e.key === "Tab" || (e.key === "ArrowRight" && el.selectionStart === value.length))) {
      e.preventDefault();
      set(value + ghost);
      return;
    }
    const collapsed = el.selectionStart === el.selectionEnd;
    if (e.key === "ArrowUp" && collapsed && !value.slice(0, el.selectionStart).includes("\n")) {
      if (hints.history.length > 0 && (recall !== null || value === "" || el.selectionStart === 0)) {
        e.preventDefault();
        step(1);
      }
      return;
    }
    if (e.key === "ArrowDown" && collapsed && recall !== null && !value.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      step(-1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      setRecall(null);
      onSubmit();
    }
  };

  return (
    <div className="relative">
      {options.length > 0 && (
        <div
          role="listbox"
          aria-label="Tables and columns"
          className="absolute bottom-full left-0 z-20 mb-1 w-64 overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {options.map((o, i) => (
            <button
              key={`${o.table ?? ""}.${o.label}`}
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(o);
              }}
              onMouseEnter={() => setSelected(i)}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
                i === selected && "bg-accent text-accent-foreground",
              )}
            >
              {o.kind === "table" ? (
                <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Columns3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-data">{o.label}</span>
              {o.table && <span className="ml-auto truncate text-muted-foreground">{o.table}</span>}
            </button>
          ))}
        </div>
      )}
      {/* The completion, drawn behind the text where the caret is */}
      <div ref={ghostRef} aria-hidden className={cn(TEXT, "pointer-events-none absolute inset-0 overflow-hidden")}>
        <span className="text-transparent">{value}</span>
        <span className="text-muted-foreground/60">{ghost}</span>
      </div>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setRecall(null);
          setMentionClosed(false);
          setSelected(0);
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onScroll={(e) => {
          if (ghostRef.current) ghostRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setMentionClosed(true)}
        onFocus={() => setMentionClosed(false)}
        rows={3}
        placeholder={placeholder}
        aria-label="Message the assistant"
        className={cn(TEXT, "relative resize-none bg-transparent outline-none placeholder:text-muted-foreground")}
      />
    </div>
  );
});
