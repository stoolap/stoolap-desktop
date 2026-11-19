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
  return isRaw ? dv : `'${dv.replace(/'/g, "''")}'`;
}

/** Extract a safe error message: first line only, file system paths stripped. */
export function safeErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  return e.message.split("\n")[0].replace(/(?:\/[\w.\-/]+)+/g, "[path]");
}

/** Split SQL on semicolons, respecting strings, identifiers, and comments. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    // Single-quoted string literal
    if (sql[i] === "'") {
      current += sql[i++];
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += sql[i++];
          break;
        } else {
          current += sql[i++];
        }
      }
      continue;
    }
    // Double-quoted identifier
    if (sql[i] === '"') {
      current += sql[i++];
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (sql[i] === '"') {
          current += sql[i++];
          break;
        } else {
          current += sql[i++];
        }
      }
      continue;
    }
    // Line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        current += sql[i++];
      }
      continue;
    }
    // Block comment
    if (sql[i] === "/" && sql[i + 1] === "*") {
      current += sql[i++];
      current += sql[i++];
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        current += sql[i++];
      }
      if (i < sql.length) {
        current += sql[i++];
        current += sql[i++];
      }
      continue;
    }
    // Statement separator
    if (sql[i] === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }
    current += sql[i++];
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);
  return statements;
}

/**
 * True when `sql` is exactly one statement that only reads (SELECT, WITH ...
 * SELECT, SHOW, DESCRIBE, EXPLAIN without ANALYZE). The assistant's
 * proposals run on their own only when this holds.
 */
export function isSingleReadOnly(sql: string): boolean {
  const stmts = splitStatements(sql).filter((s) => stripComments(s).trim());
  if (stmts.length !== 1) return false;
  // Keywords inside strings and quoted names don't count
  const code = stripComments(stmts[0])
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
    .toUpperCase();
  const first = code.split(/\s+/)[0];
  if (!["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(first)) return false;
  if (/^EXPLAIN\s+ANALYZE\b/.test(code)) return false;
  return !/\b(INSERT|UPDATE|DELETE|MERGE|RETURNING|CREATE|DROP|ALTER|TRUNCATE)\b/.test(code);
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

/** Drop -- line and block comments, keeping string literals intact. */
function stripComments(sql: string): string {
  return sql.replace(/('(?:[^']|'')*')|--[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? " ");
}
