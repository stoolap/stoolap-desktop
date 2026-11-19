/** Requests to offer in the agent, from what is open right now. */
export function contextPrompts(tab: { sql: string; lastError?: string; hasSelection: boolean } | null, tables: string[]): string[] {
  const out: string[] = [];
  // SQL with only comments in it is not a query to ask about
  const hasSql = !!tab && tab.sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "";
  if (tab?.lastError) out.push("Fix the error in this query");
  if (tab?.hasSelection) out.push("Explain the selected SQL");
  if (hasSql) out.push("Explain what this query does", "Make this query faster");
  const [a, b] = tables;
  if (a) out.push(`Show 10 sample rows from ${a}`, `Summarize the ${a} table`);
  if (a && b) out.push(`How are ${a} and ${b} related?`);
  if (!a) out.push("Create a sample table with some data");
  return out.slice(0, 5);
}
