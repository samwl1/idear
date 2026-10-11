// The insert menu: macros you can add from the toolbar's + button or by
// typing "/" in a note.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Extension, ReactRenderer, type Editor, type Range } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { Icon, type IconName } from "../components/Icon";
import { chooseImage, type PageContext } from "./macros";

export interface InsertItem {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  /** Extra words the "/" filter matches. */
  keywords: string;
  run: (editor: Editor, page: PageContext | null) => void;
}

const chainAt = (editor: Editor) => editor.chain().focus();

/** Insert a block that holds no text, and leave the cursor on a line after it
 * (otherwise it stays selected, and the next keystroke replaces it). */
function insertBlock(editor: Editor, node: { type: string; attrs?: Record<string, unknown> }) {
  chainAt(editor).insertContent([node, { type: "paragraph" }]).run();
}

export const INSERT_ITEMS: InsertItem[] = [
  {
    id: "code",
    label: "Code block",
    hint: "Code with syntax highlighting",
    icon: "log",
    keywords: "snippet pre source",
    run: (e) => chainAt(e).setCodeBlock().run(),
  },
  {
    id: "image",
    label: "Image",
    hint: "Upload an image, or paste or drop one",
    icon: "whiteboard",
    keywords: "picture photo screenshot png jpg",
    run: (e, page) => page && chooseImage(e, page),
  },
  {
    id: "table",
    label: "Table",
    hint: "Rows and columns with a header",
    icon: "project",
    keywords: "grid",
    run: (e) => chainAt(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  ...(
    [
      ["info", "Info panel", "bookmark"],
      ["note", "Note panel", "note"],
      ["warning", "Warning panel", "flag"],
      ["success", "Success panel", "check"],
      ["error", "Error panel", "bug"],
    ] as const
  ).map(([type, label, icon]) => ({
    id: `panel-${type}`,
    label,
    hint: "Highlighted block of text",
    icon,
    keywords: `panel callout ${type}`,
    run: (e: Editor) =>
      chainAt(e)
        .insertContent({ type: "panel", attrs: { type }, content: [{ type: "paragraph" }] })
        .run(),
  })),
  {
    id: "expand",
    label: "Expand",
    hint: "Content hidden until it's opened",
    icon: "chevron",
    keywords: "collapse toggle details accordion",
    run: (e) =>
      chainAt(e)
        .insertContent({ type: "expand", attrs: { title: "" }, content: [{ type: "paragraph" }] })
        .run(),
  },
  {
    id: "children",
    label: "Child pages",
    hint: "List the pages inside this one",
    icon: "folder",
    keywords: "children subpages hierarchy tree",
    run: (e) => insertBlock(e, { type: "children", attrs: { depth: "1" } }),
  },
  {
    id: "toc",
    label: "Table of contents",
    hint: "Links to this page's headings",
    icon: "view",
    keywords: "toc contents headings outline",
    run: (e) => insertBlock(e, { type: "toc" }),
  },
  {
    id: "divider",
    label: "Divider",
    hint: "A horizontal line",
    icon: "view",
    keywords: "rule line hr separator",
    run: (e) => chainAt(e).setHorizontalRule().run(),
  },
];

function matches(item: InsertItem, query: string) {
  const q = query.trim().toLowerCase();
  return !q || `${item.label} ${item.keywords}`.toLowerCase().includes(q);
}

// ---- "/" menu ------------------------------------------------------------------------

interface ListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

function SlashList({
  items,
  command,
  ref,
}: {
  items: InsertItem[];
  command: (item: InsertItem) => void;
  ref?: Ref<ListHandle>;
}) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [items]);

  // Keyboard moves keep the active row in view; the list scrolls past 20rem.
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

  if (!items.length) return <div className="slash-menu"><p className="muted small slash-empty">No matching blocks</p></div>;
  return (
    <div className="slash-menu" role="listbox" aria-label="Insert" ref={list}>
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
          <Icon name={item.icon} />
          <span className="slash-text">
            <span>{item.label}</span>
            <span className="muted small">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Typing "/" opens the insert menu at the cursor. */
export const SlashCommand = Extension.create<{ page: PageContext | null }>({
  name: "slashCommand",
  addOptions() {
    return { page: null };
  },
  addProseMirrorPlugins() {
    const page = this.options.page;
    return [
      Suggestion<InsertItem, InsertItem>({
        editor: this.editor,
        char: "/",
        // Only at the start of a word, so paths and fractions don't open it.
        allowedPrefixes: [" "],
        items: ({ query }) => INSERT_ITEMS.filter((i) => (i.id !== "image" && i.id !== "children") || page).filter((i) => matches(i, query)),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: InsertItem }) => {
          editor.chain().focus().deleteRange(range).run();
          props.run(editor, page);
        },
        render: () => {
          let renderer: ReactRenderer<ListHandle, Parameters<typeof SlashList>[0]> | null = null;
          const place = (props: SuggestionProps<InsertItem, InsertItem>) => {
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
              renderer = new ReactRenderer(SlashList, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              document.body.appendChild(renderer.element);
              place(props);
            },
            onUpdate: (props) => {
              renderer?.updateProps({ items: props.items, command: props.command });
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
