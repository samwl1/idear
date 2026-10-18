// Inline links to other pages: type "[[" and pick a page. The link is an
// ordinary link whose href is "page:<id>", so it survives renames (the text
// may go stale; the target doesn't), round-trips through markdown as
// [Title](page:<id>), and reads the same way over MCP.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Extension, ReactRenderer, type Editor, type Range } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { Icon, type IconName } from "../components/Icon";
import { api } from "../lib/api";
import type { PageContext } from "./macros";

export const PAGE_SCHEME = "page:";

/** The page id in a link href, if it's a page link. */
export function pageLinkId(href: string | null | undefined): string | null {
  return href?.startsWith(PAGE_SCHEME) ? href.slice(PAGE_SCHEME.length) : null;
}

/** Every page id linked inline from a markdown body. */
export function pageLinksIn(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\(page:([0-9a-zA-Z-]+)\)/g)) out.add(m[1]);
  return [...out];
}

interface PageItem {
  id: string;
  title: string;
  kind: string;
  /** The folder or page it sits in. */
  where: string;
}

const KIND_ICON: Record<string, IconName> = { note: "note", whiteboard: "whiteboard", tracker: "project", folder: "folder" };

/** Insert a link to `item` at the cursor (replacing `range` when given). */
export function insertPageLink(editor: Editor, item: { id: string; title: string }, range?: Range) {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  chain
    .insertContent([
      { type: "text", text: item.title || "Untitled", marks: [{ type: "link", attrs: { href: `${PAGE_SCHEME}${item.id}` } }] },
      { type: "text", text: " " },
    ])
    .run();
}

/** Typing "[[" opens a page picker at the cursor. */
export const PageLinkSuggestion = Extension.create<{ page: PageContext | null }>({
  name: "pageLinkSuggestion",
  addOptions() {
    return { page: null };
  },
  addProseMirrorPlugins() {
    const page = this.options.page;
    if (!page) return [];
    let cached: PageItem[] | null = null;
    const pages = async (): Promise<PageItem[]> => {
      if (cached) return cached;
      const nodes = await api.tree(page.session.id);
      const titles = new Map(nodes.map((n) => [n.id, n.title || (n.kind === "folder" ? "Untitled folder" : "Untitled")]));
      cached = nodes
        .filter((n) => n.kind !== "folder" && n.id !== page.pageId)
        .map((n) => ({ id: n.id, title: titles.get(n.id) ?? "Untitled", kind: n.kind, where: n.parent ? titles.get(n.parent) ?? "" : "" }));
      setTimeout(() => (cached = null), 5000);
      return cached;
    };
    return [
      Suggestion<PageItem, PageItem>({
        editor: this.editor,
        pluginKey: new PluginKey("pageLink"),
        char: "[[",
        allowSpaces: true,
        items: async ({ query }) => {
          const q = query.trim().toLowerCase();
          const all = await pages();
          const hit = q ? all.filter((p) => p.title.toLowerCase().includes(q)) : all;
          return hit.slice(0, 12);
        },
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: PageItem }) => insertPageLink(editor, props, range),
        render: () => {
          let renderer: ReactRenderer<ListHandle, Parameters<typeof PageList>[0]> | null = null;
          const place = (props: SuggestionProps<PageItem, PageItem>) => {
            const rect = props.clientRect?.();
            const el = renderer?.element as HTMLElement | undefined;
            if (!rect || !el) return;
            el.style.position = "fixed";
            el.style.zIndex = "50";
            el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
            const below = rect.bottom + 6;
            el.style.top = below + 320 > window.innerHeight ? `${Math.max(8, rect.top - 326)}px` : `${below}px`;
          };
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(PageList, { props: { items: props.items, query: props.query, command: props.command }, editor: props.editor });
              document.body.appendChild(renderer.element);
              place(props);
            },
            onUpdate: (props) => {
              renderer?.updateProps({ items: props.items, query: props.query, command: props.command });
              place(props);
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === "Escape") {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
                return true;
              }
              return renderer?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});

interface ListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

function PageList({ items, query, command, ref }: { items: PageItem[]; query: string; command: (item: PageItem) => void; ref?: Ref<ListHandle> }) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [items]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false;
      if (e.key === "ArrowDown") {
        setActive((a) => (a + 1) % items.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        setActive((a) => (a + items.length - 1) % items.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        command(items[active]);
        return true;
      }
      return false;
    },
  }));

  if (!items.length) {
    return (
      <div className="slash-menu">
        <p className="muted small slash-empty">{query ? `No page called “${query}”` : "No other pages yet"}</p>
      </div>
    );
  }
  return (
    <div className="slash-menu" role="listbox" aria-label="Link a page" ref={list}>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === active}
          data-i={i}
          className="slash-item"
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
        >
          <Icon name={KIND_ICON[item.kind] ?? "note"} />
          <span className="slash-text">
            <span>{item.title}</span>
            {item.where && <span className="muted small">in {item.where}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
