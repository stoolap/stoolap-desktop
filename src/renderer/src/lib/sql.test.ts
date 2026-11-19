import { describe, expect, it } from "vitest";
import { explainAll, formatDefaultValue, isExplain, isSingleReadOnly, quoteId, splitStatements } from "./sql-utils";

describe("isExplain", () => {
  it("sees EXPLAIN after leading comments", () => {
    expect(isExplain("-- why is this slow\nEXPLAIN ANALYZE\nSELECT 1")).toBe(true);
    expect(isExplain("/* plan */ explain select 1")).toBe(true);
    expect(isExplain("SELECT 'EXPLAIN'")).toBe(false);
    expect(isExplain("-- EXPLAIN\nSELECT 1")).toBe(false);
  });
});
import { generateTableDrops, generateTableIndexes } from "./sql-dump";
import { basename } from "./utils";
import { foldUnchanged, lineDiff } from "./line-diff";

describe("explainAll", () => {
  it("explains every statement, so none of them runs", () => {
    expect(explainAll("SELECT 1; DELETE FROM t")).toBe("EXPLAIN SELECT 1;\nEXPLAIN DELETE FROM t");
  });

  it("keeps an EXPLAIN that is there and drops empty statements", () => {
    expect(explainAll("explain analyze select 1;\n-- done\n;")).toBe("explain analyze select 1");
  });
});

describe("splitStatements", () => {
  it("splits on semicolons outside strings, identifiers and comments", () => {
    const sql = `INSERT INTO t VALUES ('a;b', 'it''s');
      SELECT "odd;name" FROM t; -- trailing; comment
      /* block; comment */ DELETE FROM t`;
    const parts = splitStatements(sql).map((s) => s.trim());
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("INSERT INTO t VALUES ('a;b', 'it''s')");
    expect(parts[1]).toBe('SELECT "odd;name" FROM t');
    expect(parts[2]).toContain("DELETE FROM t");
  });

  it("keeps non-ASCII text intact", () => {
    expect(splitStatements("INSERT INTO t VALUES ('çay')").map((s) => s.trim())).toEqual([
      "INSERT INTO t VALUES ('çay')",
    ]);
  });
});

describe("quoting", () => {
  it("doubles embedded quotes", () => {
    expect(quoteId('a"b')).toBe('"a""b"');
  });

  it("passes keywords and numbers through as DEFAULT values", () => {
    expect(formatDefaultValue("0")).toBe("0");
    expect(formatDefaultValue("current_timestamp")).toBe("current_timestamp");
    expect(formatDefaultValue("pending")).toBe("'pending'");
    expect(formatDefaultValue("it's")).toBe("'it''s'");
  });
});

describe("dump generation", () => {
  it("drops referencing tables before the tables they reference", () => {
    // Dependency order: customers is referenced by orders
    expect(generateTableDrops(["customers", "orders"])).toBe(
      'DROP TABLE IF EXISTS "orders";\nDROP TABLE IF EXISTS "customers";\n\n',
    );
    expect(generateTableDrops([])).toBe("");
  });

  it("recreates indexes with an explicit type and skips primary keys", () => {
    const sql = generateTableIndexes("orders", [
      { indexName: "pk_orders", columnName: "id", indexType: "BTREE", isUnique: true },
      { indexName: "idx_status", columnName: "status", indexType: "HASH", isUnique: false },
      { indexName: "idx_pair", columnName: "(a, b)", indexType: "MULTICOLUMN", isUnique: true },
      {
        indexName: "idx_vec",
        columnName: "embedding",
        indexType: "HNSW",
        isUnique: false,
        options: "metric=cosine, m=16, ef_construction=128",
      },
    ]);
    expect(sql.split("\n").filter(Boolean)).toEqual([
      'CREATE INDEX IF NOT EXISTS "idx_status" ON "orders"("status") USING HASH;',
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_pair" ON "orders"("a", "b");',
      `CREATE INDEX IF NOT EXISTS "idx_vec" ON "orders"("embedding") USING HNSW WITH (metric = 'cosine', m = 16, ef_construction = 128);`,
    ]);
  });
});

describe("basename", () => {
  it("handles both path separators", () => {
    expect(basename("/Users/me/data/shop")).toBe("shop");
    expect(basename("C:\\Users\\me\\shop.sql")).toBe("shop.sql");
    expect(basename("/Users/me/data/")).toBe("data");
  });
});

describe("lineDiff", () => {
  it("marks removed and added lines around unchanged ones", () => {
    expect(lineDiff("SELECT *\nFROM t\nWHERE a = 1", "SELECT id\nFROM t\nWHERE a = 1\nLIMIT 5")).toEqual([
      { type: "remove", text: "SELECT *" },
      { type: "add", text: "SELECT id" },
      { type: "same", text: "FROM t" },
      { type: "same", text: "WHERE a = 1" },
      { type: "add", text: "LIMIT 5" },
    ]);
  });

  it("handles an empty side", () => {
    expect(lineDiff("", "SELECT 1")).toEqual([
      { type: "remove", text: "" },
      { type: "add", text: "SELECT 1" },
    ]);
  });
});

describe("foldUnchanged", () => {
  it("keeps context around changes and folds the rest", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "e", "F", "g", "h"].join("\n");
    expect(foldUnchanged(lineDiff(before, after), 1)).toEqual([
      { type: "skip", count: 4 },
      { type: "same", text: "e" },
      { type: "remove", text: "f" },
      { type: "add", text: "F" },
      { type: "same", text: "g" },
      { type: "same", text: "h" },
    ]);
  });
});

describe("isSingleReadOnly", () => {
  it("accepts one reading statement", () => {
    expect(isSingleReadOnly("SELECT * FROM t")).toBe(true);
    expect(isSingleReadOnly("-- top customers\nSELECT name FROM c;")).toBe(true);
    expect(isSingleReadOnly("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
    expect(isSingleReadOnly("SELECT 'delete me' AS note")).toBe(true);
    expect(isSingleReadOnly("EXPLAIN SELECT 1")).toBe(true);
  });

  it("rejects writes, several statements and EXPLAIN ANALYZE", () => {
    expect(isSingleReadOnly("UPDATE t SET a = 1")).toBe(false);
    expect(isSingleReadOnly("DELETE FROM t RETURNING id")).toBe(false);
    expect(isSingleReadOnly("WITH x AS (SELECT 1) DELETE FROM t")).toBe(false);
    expect(isSingleReadOnly("SELECT 1; SELECT 2")).toBe(false);
    expect(isSingleReadOnly("EXPLAIN ANALYZE SELECT 1")).toBe(false);
    expect(isSingleReadOnly("")).toBe(false);
  });
});
