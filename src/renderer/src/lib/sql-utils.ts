/** Quote a SQL identifier with double-quotes, escaping embedded quotes. Server-safe. */
export function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Format a user-typed DEFAULT value: numbers, NULL/TRUE/FALSE, the
 * CURRENT_* keywords and already-quoted strings pass through; anything else
 * becomes a quoted string literal.
 */
export function formatDefaultValue(value: string): string {
  const dv = value.trim();
  const isRaw =
    /^-?\d+(\.\d+)?$/.test(dv) ||
    /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(
      dv,
    ) ||
    (dv.startsWith("'") && dv.endsWith("'"));
  // Stoolap reads backslash escapes inside quotes, so \ is doubled too
  return isRaw ? dv : `'${dv.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Extract a safe error message: first line only, file system paths stripped. */
export function safeErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  return e.message.split("\n")[0].replace(/(?:\/[\w.\-/]+)+/g, "[path]");
}

/**
 * Split SQL on semicolons, reading quotes and comments the way Stoolap's
 * lexer does: in '...' a backslash escapes the next character (and '' is a
 * quote); "..." and `...` are names, closed only by their quote (doubled to
 * escape); -- and # run to the end of the line; block comments don't nest.
 * The cases in sql-split-cases.json are checked against the engine itself.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const s = sql.slice(start, end).trim();
    if (s) statements.push(s);
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
    } else if (c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) {
          i++;
          break;
        } else i++;
      }
    } else if ((c === "-" && sql[i + 1] === "-") || c === "#") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === ";") {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return statements;
}

/**
 * True when `sql` is exactly one statement that only reads (SELECT, WITH ...
 * SELECT, SHOW, DESCRIBE, EXPLAIN without ANALYZE). The agent's
 * proposals run on their own only when this holds.
 */
export function isSingleReadOnly(sql: string): boolean {
  const stmts = splitStatements(sql).filter((s) => stripComments(s).trim());
  if (stmts.length !== 1) return false;
  // Keywords inside strings, quoted names and comments don't count. One
  // pass, so a quote inside a name is never taken for a string's start
  const code = stmts[0]
    .replace(QUOTED_OR_COMMENT, (_, quoted?: string) => (quoted ? quoted[0].repeat(2) : " "))
    .trim()
    .toUpperCase();
  const first = code.split(/\s+/)[0];
  if (!["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(first)) return false;
  if (/^EXPLAIN\s+ANALYZE\b/.test(code)) return false;
  return !/\b(INSERT|UPDATE|DELETE|MERGE|RETURNING|CREATE|DROP|ALTER|TRUNCATE)\b/.test(code);
}

/** True when `sql` has a RETURNING clause (strings, names and comments aside): its rows are what it wrote. */
export function hasReturning(sql: string): boolean {
  return /\bRETURNING\b/i.test(sql.replace(QUOTED_OR_COMMENT, (_, quoted?: string) => (quoted ? quoted[0].repeat(2) : " ")));
}

/**
 * For an EXPLAIN, whether making its plan ran a write: EXPLAIN ANALYZE runs
 * its statement, so EXPLAIN ANALYZE UPDATE changes data. Undefined when
 * `sql` isn't an EXPLAIN.
 */
export function explainKind(sql: string): "read" | "write" | undefined {
  if (!isExplain(sql)) return undefined;
  const code = sql.replace(QUOTED_OR_COMMENT, (_, quoted?: string) => (quoted ? quoted[0].repeat(2) : " ")).trim();
  return /^EXPLAIN\s+ANALYZE\b/i.test(code) && /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(code) ? "write" : "read";
}

/** True when `sql` is an EXPLAIN (or EXPLAIN ANALYZE), comments before it aside. */
export function isExplain(sql: string): boolean {
  return /^EXPLAIN\b/i.test(stripComments(sql).trimStart());
}

/**
 * `sql` with EXPLAIN in front of every statement that lacks one, so Explain
 * never runs a statement: `SELECT 1; DELETE FROM t` must not delete.
 */
export function explainAll(sql: string): string {
  return splitStatements(sql)
    .filter((s) => stripComments(s).trim())
    .map((s) => (isExplain(s) ? s : `EXPLAIN ${s}`))
    .join(";\n");
}

/** Drop --, # and block comments, keeping strings and quoted names intact. */
function stripComments(sql: string): string {
  return sql.replace(QUOTED_OR_COMMENT, (_, quoted?: string) => quoted ?? " ");
}

/** A string, quoted name (group 1) or comment, read as the engine reads them */
const QUOTED_OR_COMMENT =
  /('(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`)|(?:--|#)[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
