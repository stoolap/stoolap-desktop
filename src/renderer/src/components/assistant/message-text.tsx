import { Children, isValidElement, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { sql } from "@codemirror/lang-sql";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StoolapDialect } from "@/components/editor/sql-editor";
import * as assistant from "@/lib/assistant";

const sqlParser = sql({ dialect: StoolapDialect }).language.parser;

/** SQL coloured like the editor, through the tok-* classes in globals.css */
function highlightSql(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  highlightCode(
    code,
    sqlParser.parse(code),
    classHighlighter,
    (text, classes) =>
      out.push(
        classes ? (
          <span key={out.length} className={classes}>
            {text}
          </span>
        ) : (
          text
        ),
      ),
    () => out.push("\n"),
  );
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="group relative">
      <pre className="font-data overflow-x-auto rounded-md bg-muted px-2.5 py-2 text-xs">
        {lang === "sql" ? highlightSql(code) : code}
      </pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute right-1 top-1 h-6 w-6 bg-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Copy code"
        onClick={() =>
          navigator.clipboard.writeText(code).then(
            () => toast.success("Copied"),
            () => toast.error("Could not copy"),
          )
        }
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

const components: Components = {
  // A fenced block: <pre><code class="language-x">; inline code is styled in CSS
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
    const lang = /language-(\S+)/.exec(child.props.className ?? "")?.[1] ?? "";
    return <CodeBlock lang={lang.toLowerCase()} code={String(child.props.children ?? "").replace(/\n$/, "")} />;
  },
  // Links open in the browser, never inside the app
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) assistant.openLink(href).catch((err) => toast.error(String(err)));
        }}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto">
        <table>{children}</table>
      </div>
    );
  },
};

/** An assistant reply, rendered as GitHub-flavoured Markdown. */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="assistant-md text-sm leading-relaxed">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
