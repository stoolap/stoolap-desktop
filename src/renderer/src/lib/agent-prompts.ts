import i18n from "@/lib/i18n";

/** Requests to offer in the agent, from what is open right now. */
export function contextPrompts(tab: { sql: string; lastError?: string; hasSelection: boolean } | null, tables: string[]): string[] {
  const out: string[] = [];
  // SQL with only comments in it is not a query to ask about
  const hasSql = !!tab && tab.sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "";
  if (tab?.lastError) out.push(i18n.t("agent:prompts.fixError"));
  if (tab?.hasSelection) out.push(i18n.t("agent:prompts.explainSelection"));
  if (hasSql) out.push(i18n.t("agent:prompts.explainQuery"), i18n.t("agent:prompts.faster"));
  const [a, b] = tables;
  if (a) out.push(i18n.t("agent:prompts.sampleRows", { table: a }), i18n.t("agent:prompts.summarize", { table: a }));
  if (a && b) out.push(i18n.t("agent:prompts.related", { a, b }));
  if (!a) out.push(i18n.t("agent:prompts.sampleTable"));
  return out.slice(0, 5);
}
