import { describe, expect, it, vi } from "vitest";

// The backend refuses a DROP the way Stoolap 0.5.0 does for a referenced table
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (_cmd: string, args: { sql: string }) => {
    if (args.sql.startsWith("DROP")) {
      throw "foreign key constraint violation: column 'customer_id' in table 'orders' references 'customers(id)'";
    }
    return { ddl: "CREATE TABLE", time: 1 };
  }),
}));

import { executeQuery, runSql } from "./api-client";

describe("runSql", () => {
  it("throws when the statement fails, unlike executeQuery", async () => {
    await expect(executeQuery("c", "DROP TABLE customers")).resolves.toEqual({
      error: expect.stringContaining("foreign key"),
    });
    await expect(runSql("c", "DROP TABLE customers")).rejects.toThrow("foreign key");
  });

  it("returns the result when it succeeds", async () => {
    await expect(runSql("c", "CREATE TABLE t (id INTEGER PRIMARY KEY)")).resolves.toEqual({
      ddl: "CREATE TABLE",
      time: 1,
    });
  });
});
