import { describe, expect, it } from "vitest";
import { contextPrompts } from "./assistant-prompts";
import { completion, mentionOptions } from "@/components/assistant/composer";

describe("contextPrompts", () => {
  it("offers fixing an error first, and asks about the query only when there is one", () => {
    const p = contextPrompts({ sql: "SELECT 1", lastError: "boom", hasSelection: false }, ["orders", "customers"]);
    expect(p[0]).toBe("Fix the error in this query");
    expect(p).toContain("Explain what this query does");
    expect(p.length).toBeLessThanOrEqual(5);
    const empty = contextPrompts({ sql: "-- just a note\n", hasSelection: false }, ["orders"]);
    expect(empty).toEqual(["Show 10 sample rows from orders", "Summarize the orders table"]);
  });
  it("suggests starting a table in an empty database", () => {
    expect(contextPrompts(null, [])).toEqual(["Create a sample table with some data"]);
  });
});

describe("composer hints", () => {
  const schema = { orders: ["id", "customer_id", "total"], customers: ["id", "name"] };
  it("completes an earlier request first, then a name", () => {
    const hints = { history: ["Show the top customers"], prompts: ["Show 10 sample rows from orders"], schema };
    expect(completion("show the", hints)).toBe(" top customers");
    expect(completion("Show 10", hints)).toBe(" sample rows from orders");
    expect(completion("total per cust", hints)).toBe("omers");
    expect(completion("", hints)).toBe("");
  });
  it("lists tables, then columns, and a table's columns after a dot", () => {
    expect(mentionOptions(schema, "").map((o) => o.label)).toEqual(["orders", "customers"]);
    expect(mentionOptions(schema, "cu").map((o) => o.label)).toEqual(["customers", "customer_id"]);
    expect(mentionOptions(schema, "orders.t").map((o) => o.label)).toEqual(["total"]);
  });
});
