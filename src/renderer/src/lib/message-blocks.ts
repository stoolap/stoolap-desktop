export type MessageBlock = { kind: "text"; text: string } | { kind: "code"; lang: string; code: string };

/**
 * Split a reply into text and fenced code blocks. A fence opens at the start
 * of a line with three or more backticks (or tildes) and closes on a line
 * with only a fence as long or longer. Inside a block, a fence with a
 * language (```sql) opens a nested block, so a code block that holds
 * another one, like a gh command with a Markdown body, stays whole.
 */
export function messageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  let lang = "";
  let depth = 0;

  const flushProse = () => {
    const t = prose.join("\n");
    if (t.trim()) blocks.push({ kind: "text", text: t.replace(/^\n+|\n+$/g, "") });
    prose = [];
  };

  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/.exec(line);
    if (code === null) {
      if (m) {
        flushProse();
        code = [];
        fence = m[1];
        lang = m[2];
        depth = 0;
      } else {
        prose.push(line);
      }
      continue;
    }
    const sameKind = m && m[1][0] === fence[0] && m[1].length >= fence.length;
    if (sameKind && m[2]) {
      depth++;
    } else if (sameKind && !m[2]) {
      if (depth === 0) {
        blocks.push({ kind: "code", lang, code: code.join("\n") });
        code = null;
        continue;
      }
      depth--;
    }
    code.push(line);
  }
  // A block still streaming in, or never closed
  if (code !== null) blocks.push({ kind: "code", lang, code: code.join("\n") });
  else flushProse();
  return blocks;
}
