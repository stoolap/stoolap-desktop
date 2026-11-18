import { describe, expect, it } from "vitest";
import { messageBlocks } from "./message-blocks";

describe("messageBlocks", () => {
  it("splits prose and code, keeping inline backticks in prose", () => {
    const b = messageBlocks("Run `x`:\n```sql\nSELECT 1;\n```\nDone.");
    expect(b).toEqual([
      { kind: "text", text: "Run `x`:" },
      { kind: "code", lang: "sql", code: "SELECT 1;" },
      { kind: "text", text: "Done." },
    ]);
  });

  it("keeps a code block whole when it holds a fenced block", () => {
    const cmd = "gh issue create --body-file - <<'EOF'\n### Repro\n```sql\nSELECT 1;\n```\nEOF";
    const b = messageBlocks(`Here:\n\`\`\`bash\n${cmd}\n\`\`\`\nThat's it.`);
    expect(b).toEqual([
      { kind: "text", text: "Here:" },
      { kind: "code", lang: "bash", code: cmd },
      { kind: "text", text: "That's it." },
    ]);
  });

  it("closes a longer fence only with one as long", () => {
    const b = messageBlocks("````md\n```\ninner\n```\n````");
    expect(b).toEqual([{ kind: "code", lang: "md", code: "```\ninner\n```" }]);
  });

  it("shows a block still streaming in as code", () => {
    expect(messageBlocks("```sql\nSELECT")).toEqual([{ kind: "code", lang: "sql", code: "SELECT" }]);
  });
});
