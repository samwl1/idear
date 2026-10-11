import { useEffect, useMemo, useRef } from "react";
import { Marked, type Tokens } from "marked";
import { HELP_DOCS, docForHref } from "../help/docs";
import { openExternal } from "../lib/openLink";
import { Icon } from "./Icon";

/** Heading text to an id: "1. Check your home connection" -> "1-check-your-home-connection". */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// The docs are the app's own bundled files, so their HTML is trusted.
const md = new Marked({
  gfm: true,
  renderer: {
    heading(this: { parser: { parseInline: (t: Tokens.Heading["tokens"]) => string } }, { tokens, depth }: Tokens.Heading) {
      const html = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(html)}">${html}</h${depth}>\n`;
    },
  },
});

interface Props {
  doc: string;
  /** Section to scroll to on open. */
  anchor?: string | null;
  onOpen: (doc: string, anchor?: string | null) => void;
}

export function HelpPage({ doc, anchor, onOpen }: Props) {
  const current = HELP_DOCS.find((d) => d.id === doc) ?? HELP_DOCS[0];
  const html = useMemo(() => md.parse(current.body, { async: false }) as string, [current]);
  const sections = useMemo(
    () =>
      md
        .lexer(current.body)
        .filter((t): t is Tokens.Heading => t.type === "heading" && t.depth === 2)
        .map((t) => ({ id: slug(md.parseInline(t.text, { async: false }) as string), text: t.text.replace(/`/g, "") })),
    [current],
  );
  const article = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = anchor ? article.current?.querySelector(`#${CSS.escape(anchor)}`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else article.current?.parentElement?.scrollTo({ top: 0 });
  }, [current, anchor]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      article.current?.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ block: "start" });
      return;
    }
    if (openExternal(href)) return;
    const target = docForHref(href);
    if (target) onOpen(target.doc.id, target.anchor);
  };

  return (
    <div className="help">
      <nav className="help-nav" aria-label="Help topics">
        <h2>Help</h2>
        <ul>
          {HELP_DOCS.map((d) => (
            <li key={d.id}>
              <button className="nav-item" data-active={d.id === current.id || undefined} onClick={() => onOpen(d.id)}>
                <Icon name="book" /> <span className="row-label">{d.title}</span>
              </button>
            </li>
          ))}
        </ul>
        {sections.length > 1 && (
          <>
            <h3>On this page</h3>
            <ul className="help-toc">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} onClick={onClick}>
                    {s.text}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <div className="help-scroll">
        <article
          ref={article}
          className="prose help-doc"
          onClick={onClick}
          // Bundled docs from this repo, rendered by marked.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
