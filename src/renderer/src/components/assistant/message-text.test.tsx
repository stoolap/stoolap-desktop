import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "./message-text";

const render = (text: string) => renderToStaticMarkup(<MessageText text={text} />);

describe("MessageText", () => {
  it("renders bold around inline code, lists and tables", () => {
    const html = render("- **`TRUNCATE` sonrası:** boş\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<li><strong><code>TRUNCATE</code> sonrası:</strong> boş</li>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("keeps a four-backtick block that holds a fenced block whole", () => {
    const html = render("````bash\ngh issue create <<'EOF'\n```sql\nSELECT 1;\n```\nEOF\n````");
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html).toContain("```sql\nSELECT 1;\n```");
  });

  it("highlights SQL blocks", () => {
    expect(render("```sql\nSELECT 'x';\n```")).toContain('<span class="tok-keyword">SELECT</span>');
  });
});
