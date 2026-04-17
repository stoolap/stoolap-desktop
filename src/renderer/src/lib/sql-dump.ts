import { quoteId } from "./sql-utils";

export interface DumpOptions {
  tables: boolean;
  data: boolean;
  views: boolean;
  indexes: boolean;
  dropBeforeCreate: boolean;
}

export const DEFAULT_DUMP_OPTIONS: DumpOptions = {
  tables: true,
  data: true,
  views: true,
  indexes: true,
  dropBeforeCreate: true,
};

/**
 * Escape a value for use in a SQL INSERT statement.
 */
export function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number")
    return isFinite(value) ? String(value) : "NULL";
  const str = String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Generate INSERT statements for rows. One INSERT per row.
 */
export function generateInserts(
  tableName: string,
  columns: string[],
  rows: unknown[][],
): string {
  if (rows.length === 0) return "";
  const quotedCols = columns.map(quoteId).join(", ");
  const lines: string[] = [];
  for (const row of rows) {
    const values = row.map(escapeSqlValue).join(", ");
    lines.push(
      `INSERT INTO ${quoteId(tableName)} (${quotedCols}) VALUES (${values});`,
    );
  }
  return lines.join("\n");
}

/**
 * Generate the SQL dump file header comment.
 */
export function generateHeader(connectionName: string): string {
  const dateStr = new Date().toISOString().slice(0, 19).replace("T", " ");
  return [
    "-- Stoolap Studio SQL Dump",
    `-- Database: ${connectionName}`,
    `-- Date: ${dateStr}`,
    "-- ---",
    "",
  ].join("\n");
}

/**
 * Generate the dump section for a single table.
 */
export function generateTableSection(
  tableName: string,
  ddl: string,
  columns: string[],
  rows: unknown[][],
  options: DumpOptions,
): string {
  const parts: string[] = [];
  parts.push(`-- Table: ${tableName}`);

  if (options.dropBeforeCreate) {
    parts.push(`DROP TABLE IF EXISTS ${quoteId(tableName)};`);
  }
  // DDL from SHOW CREATE TABLE does not end with semicolon
  parts.push(`${ddl};`);
  parts.push("");

  if (options.data && rows.length > 0) {
    parts.push(generateInserts(tableName, columns, rows));
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Generate CREATE INDEX statements for a table.
 * Handles multi-column indexes (columnName = "(a, b)"), HNSW, and unique indexes.
 * Skips auto-created primary key (pk_*) indexes.
 */
export function generateTableIndexes(
  tableName: string,
  indexes: {
    indexName: string;
    columnName: string;
    indexType: string;
    isUnique: boolean;
    options?: string;
  }[],
): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const idx of indexes) {
    // Skip primary key auto-indexes (recreated by DDL)
    if (idx.indexName.startsWith("pk_")) continue;
    // Deduplicate by index name
    if (seen.has(idx.indexName)) continue;
    seen.add(idx.indexName);

    // Parse column list — stoolap returns "(a, b)" for multi-column
    let columnList: string;
    const colStr = idx.columnName.trim();
    if (colStr.startsWith("(") && colStr.endsWith(")")) {
      // Multi-column: "(a, b)" → quote each column
      const cols = colStr
        .slice(1, -1)
        .split(",")
        .map((c) => quoteId(c.trim()));
      columnList = cols.join(", ");
    } else {
      columnList = quoteId(colStr);
    }

    const isHnsw = idx.indexType.toUpperCase() === "HNSW";
    if (isHnsw) {
      // Parse options like "metric=cosine, m=16, ef_construction=128"
      let withClause = "";
      if (idx.options) {
        const opts: string[] = [];
        for (const part of idx.options.split(",").map((s) => s.trim())) {
          const [key, val] = part.split("=").map((s) => s.trim());
          if (key === "metric") opts.push(`metric = '${val}'`);
          else if (key === "m") opts.push(`m = ${val}`);
          else if (key === "ef_construction") opts.push(`ef_construction = ${val}`);
        }
        if (opts.length > 0) withClause = ` WITH (${opts.join(", ")})`;
      }
      lines.push(
        `CREATE INDEX ${quoteId(idx.indexName)} ON ${quoteId(tableName)}(${columnList}) USING HNSW${withClause};`,
      );
    } else {
      const unique = idx.isUnique ? "UNIQUE " : "";
      lines.push(
        `CREATE ${unique}INDEX ${quoteId(idx.indexName)} ON ${quoteId(tableName)}(${columnList});`,
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/**
 * Generate the dump section for a single view.
 */
export function generateViewSection(
  viewName: string,
  ddl: string,
  options: DumpOptions,
): string {
  const parts: string[] = [];
  parts.push(`-- View: ${viewName}`);

  if (options.dropBeforeCreate) {
    parts.push(`DROP VIEW IF EXISTS ${quoteId(viewName)};`);
  }
  parts.push(`${ddl};`);
  parts.push("");

  return parts.join("\n");
}
