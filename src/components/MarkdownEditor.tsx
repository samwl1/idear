import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NodeSelection } from "@tiptap/pm/state";
import { Placeholder } from "@tiptap/extensions";
import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import {
  AttachmentImage,
  ChildPagesMacro,
  CodeBlock,
  Expand,
  ImageInput,
  Panel,
  TocMacro,
  type PageContext,
} from "../editor/macros";
import { INSERT_ITEMS, SlashCommand } from "../editor/insert";
import { Icon } from "./Icon";
import { useDebounced } from "../lib/useDebounced";
import { openExternal } from "../lib/openLink";
import { useCanEdit } from "../lib/access";

// Notes are stored as markdown. Markdown has no syntax for color, so colored
// and highlighted text are written as small inline HTML spans, which the
// markdown parser reads back. Colors are restricted to safe CSS color values.
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

/**
 * Tab indents instead of leaving the editor: a list item nests under the one
 * above (Shift+Tab lifts it), a code block gets two spaces, and anywhere else
 * a tab character goes in.
 */
const TabKey = Extension.create({
  name: "tabKey",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive("codeBlock")) return editor.commands.insertContent("  ");
        // A list item nests under the one above it. The first item of a list
        // has nothing to nest under (the document model can't hold a deeper
        // level without a parent item), so Tab does nothing there; a tab
        // character never lands in a list, where it would move the text and
        // leave the bullet behind.
        for (const item of ["taskItem", "listItem"] as const) {
          if (!editor.isActive(item)) continue;
          return editor.commands.sinkListItem(item) || true;
        }
        return editor.commands.insertContent("\t");
      },
      "Shift-Tab": ({ editor }) => {
        // Take back a tab or two spaces before the cursor; otherwise lift the list item.
        const { from } = editor.state.selection;
        const before = editor.state.doc.textBetween(Math.max(0, from - 2), from, "\n");
        if (before === "  " && editor.isActive("codeBlock")) return editor.commands.deleteRange({ from: from - 2, to: from });
        for (const item of ["taskItem", "listItem"] as const) {
          if (!editor.isActive(item)) continue;
          if (editor.commands.liftListItem(item)) return true;
          return true;
        }
        if (before.endsWith("\t")) return editor.commands.deleteRange({ from: from - 1, to: from });
        return true;
      },
    };
  },
});
/**
 * Alt+Up and Alt+Down move the top-level block the cursor is in (a paragraph,
 * heading, list, panel, expand, code block, table…) past its neighbour.
 */
const MoveBlock = Extension.create({
  name: "moveBlock",
  addKeyboardShortcuts() {
    const move =
      (dir: -1 | 1) =>
      ({ editor }: { editor: Editor }) => {
        const { state } = editor;
        const { $from, $to } = state.selection;
        // The top-level block holding the selection; a selection across blocks stays put.
        const index = $from.index(0);
        if ($to.index(0) !== index) return false;
        const doc = state.doc;
        const target = index + dir;
        if (target < 0 || target >= doc.childCount) return false;
        const block = doc.child(index);
        const other = doc.child(target);
        const first = Math.min(index, target);
        let from = 0;
        for (let i = 0; i < first; i++) from += doc.child(i).nodeSize;
        // Swap the two neighbours in one replace, then put the cursor back inside the moved block.
        const oldStart = dir === 1 ? from : from + other.nodeSize;
        const newStart = dir === 1 ? from + other.nodeSize : from;
        const offset = $from.pos - oldStart;
        const tr = state.tr.replaceWith(from, from + block.nodeSize + other.nodeSize, dir === 1 ? [other, block] : [block, other]);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(newStart + offset, tr.doc.content.size))));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      };
    return { "Alt-ArrowUp": move(-1), "Alt-ArrowDown": move(1) };
  },
});

const safe = (c: unknown) => (typeof c === "string" && SAFE_COLOR.test(c.trim()) ? c.trim() : null);

type MdHelpers = { renderChildren: (node: unknown) => string };
type MdNode = { attrs?: Record<string, unknown> };

// Low priority puts color innermost, so bold or italic markdown wraps the span
// (`**<span>…</span>**`). The other way round, markdown inside the span
// wouldn't be parsed back.
const ColoredText = TextStyle.extend({
  priority: 40,
  renderMarkdown(node: MdNode, h: MdHelpers) {
    const inner = h.renderChildren(node);
    const color = safe(node.attrs?.color);
    return color ? `<span style="color: ${color}">${inner}</span>` : inner;
  },
} as never);

const ColoredHighlight = Highlight.extend({
  priority: 41,
  renderMarkdown(node: MdNode, h: MdHelpers) {
    const inner = h.renderChildren(node);
    const color = safe(node.attrs?.color);
    return color ? `<mark data-color="${color}" style="background-color: ${color}">${inner}</mark>` : `==${inner}==`;
  },
} as never).configure({ multicolor: true });

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const TEXT_COLORS = [
  { label: "Grey", value: "#868e96" },
  { label: "Red", value: "#e03131" },
  { label: "Orange", value: "#e8590c" },
  { label: "Yellow", value: "#e0a800" },
  { label: "Green", value: "#2f9e44" },
  { label: "Teal", value: "#0c8599" },
  { label: "Blue", value: "#1971c2" },
  { label: "Violet", value: "#7048e8" },
  { label: "Pink", value: "#c2255c" },
];

export const HIGHLIGHTS = [
  { label: "Yellow", value: "#fff3bf" },
  { label: "Green", value: "#d3f9d8" },
  { label: "Blue", value: "#d0ebff" },
  { label: "Red", value: "#ffe3e3" },
  { label: "Violet", value: "#f3d9fa" },
  { label: "Grey", value: "#e9ecef" },
];

interface Props {
  initial: string;
  /** Called with markdown after a pause in typing, and on unmount if anything is pending. */
  onChange: (markdown: string) => void;
  label: string;
  className?: string;
  delay?: number;
  /** Show the floating formatting toolbar. Off when the page renders a `Toolbar` of its own. */
  toolbar?: boolean;
  onEditor?: (e: Editor | null) => void;
  /** The page this editor is on, for images, child pages, and other macros. */
  page?: PageContext;
}

/** Rich text editing over a markdown string. Keyed by its owner so content loads once. */
export function MarkdownEditor({
  initial,
  onChange,
  label,
  className = "prose",
  delay = 600,
  toolbar = true,
  onEditor,
  page,
}: Props) {
  const save = useDebounced(onChange, delay);
  const canEdit = useCanEdit();
  // Built once per page: the editor is created once, and rebuilding this
  // list every render would only throw it away. The editing-only extensions
  // are always present; they can't fire while the editor isn't editable.
  const extensions = useMemo(
    () => [
      // Clicks on links are handled below so they open in the system browser,
      // not inside the app's own window.
      StarterKit.configure({
        codeBlock: false,
        link: {
          openOnClick: false,
          autolink: true,
          protocols: ["http", "https", "mailto"],
          HTMLAttributes: { title: `${MOD}click to open` },
        },
      }),
      ColoredText,
      Color,
      ColoredHighlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlock,
      AttachmentImage.configure({ page: page ?? null }),
      ImageInput.configure({ page: page ?? null }),
      Panel,
      Expand,
      ChildPagesMacro.configure({ page: page ?? null }),
      TocMacro,
      // Markdown tables hold one line of text per cell, so cells hold only paragraphs.
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader.extend({ content: "paragraph+" }),
      TableCell.extend({ content: "paragraph+" }),
      SlashCommand.configure({ page: page ?? null }),
      TabKey,
      MoveBlock,
      // The slash menu is how blocks get inserted; say so on the empty line the cursor is on.
      Placeholder.configure({
        placeholder: ({ editor: e }) => (e.isEmpty ? "Write, or type / to insert a block" : "Type / to insert a block"),
        showOnlyCurrent: true,
        includeChildren: false,
      }),
      Markdown,
    ],
    [page],
  );
  const editor = useEditor({
    editable: canEdit,
    extensions,
    content: initial,
    contentType: "markdown",
    editorProps: {
      attributes: { class: className, "aria-label": label },
      // A plain click edits the link like any text; Cmd+click (Ctrl+click on
      // Linux) opens it in the system browser. The DOM click is always
      // prevented so the webview itself never follows the link.
      handleDOMEvents: {
        click: (_view, event) => {
          const a = (event.target as HTMLElement | null)?.closest("a[href]");
          if (!a) return false;
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) {
            openExternal(a.getAttribute("href"));
            return true;
          }
          return false;
        },
      },
    },
    onUpdate: ({ editor }) => save(editor.getMarkdown()),
  });

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  // A role change arriving over sync (editor to viewer, or back) switches the
  // live editor; the option above is only read when it's created.
  useEffect(() => {
    if (editor && editor.isEditable !== canEdit) editor.setEditable(canEdit);
  }, [editor, canEdit]);

  return (
    <div className="rich">
      {toolbar && canEdit && editor && <FloatingToolbar editor={editor} page={page ?? null} />}
      <EditorContent editor={editor} className="body" />
    </div>
  );
}

// ---- toolbar ----------------------------------------------------------------------

/**
 * The formatting bar floats above the selection and shows only while there is
 * one (or the cursor is in a table, whose controls have no other home). It stays
 * while one of its own popovers has focus, such as the link field.
 */
function FloatingToolbar({ editor, page }: { editor: Editor; page: PageContext | null }) {
  const sel = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      empty: e.state.selection.empty,
      from: e.state.selection.from,
      to: e.state.selection.to,
      focused: e.isFocused,
      table: e.isActive("table"),
      node: e.state.selection instanceof NodeSelection,
    }),
  });
  const [focusWithin, setFocusWithin] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const wanted = (!sel.empty || sel.table) && !sel.node && (sel.focused || focusWithin);

  useLayoutEffect(() => {
    if (!wanted) {
      setPos(null);
      return;
    }
    const el = root.current;
    const box = el?.parentElement?.getBoundingClientRect();
    if (!el || !box) return;
    const a = editor.view.coordsAtPos(sel.from);
    const b = editor.view.coordsAtPos(sel.to);
    const topOfSel = Math.min(a.top, b.top) - box.top;
    const bottomOfSel = Math.max(a.bottom, b.bottom) - box.top;
    const gap = 8;
    // Above the selection, as long as that stays inside the scrolling pane; else below.
    const paneTop = (el.closest(".main, .drawer")?.getBoundingClientRect().top ?? box.top) - box.top;
    const above = topOfSel - el.offsetHeight - gap;
    const top = above >= paneTop ? above : bottomOfSel + gap;
    const mid = a.top === b.top ? (a.left + b.left) / 2 - box.left : a.left - box.left;
    const left = Math.max(0, Math.min(mid - el.offsetWidth / 2, box.width - el.offsetWidth));
    setPos({ top, left });
  }, [wanted, sel.from, sel.to, editor]);

  return (
    <div
      ref={root}
      className="toolbar-float"
      data-open={wanted || undefined}
      style={pos ? { top: pos.top, left: pos.left } : undefined}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <Toolbar editor={editor} page={page} />
    </div>
  );
}

/** The formatting bar. Pages with a top bar render it there; `insert` adds the macro menu. */
export function Toolbar({ editor, page, insert = false }: { editor: Editor; page: PageContext | null; insert?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive("heading", { level: 1 })
        ? "h1"
        : e.isActive("heading", { level: 2 })
          ? "h2"
          : e.isActive("heading", { level: 3 })
            ? "h3"
            : e.isActive("codeBlock")
              ? "code"
              : "p",
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      tasks: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      table: e.isActive("table"),
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      highlight: (e.getAttributes("highlight").color as string | undefined) ?? null,
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <BlockMenu block={s.block} editor={editor} />

      <Sep />
      <Btn label="Bold" kbd={`${MOD}B`} active={s.bold} onClick={() => chain().toggleBold().run()}>
        <b>B</b>
      </Btn>
      <Btn label="Italic" kbd={`${MOD}I`} active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <i>I</i>
      </Btn>
      <Btn label="Underline" kbd={`${MOD}U`} active={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <u>U</u>
      </Btn>
      <Btn label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <s>S</s>
      </Btn>
      <Btn label="Inline code" active={s.code} onClick={() => chain().toggleCode().run()}>
        <code>{"<>"}</code>
      </Btn>

      <Sep />
      <ColorMenu
        label="Text color"
        swatches={TEXT_COLORS}
        current={s.color}
        preview={<span className="tb-a" style={{ color: s.color ?? undefined }}>A</span>}
        onPick={(c) => (c ? chain().setColor(c).run() : chain().unsetColor().run())}
      />
      <ColorMenu
        label="Highlight"
        swatches={HIGHLIGHTS}
        current={s.highlight}
        preview={<span className="tb-hl" style={{ background: s.highlight ?? "#fff3bf" }}>A</span>}
        onPick={(c) => (c ? chain().setHighlight({ color: c }).run() : chain().unsetHighlight().run())}
      />

      <Sep />
      <Btn label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        <Glyph d="M6 4.5h7.5 M6 8h7.5 M6 11.5h7.5 M3 4.5h.01 M3 8h.01 M3 11.5h.01" />
      </Btn>
      <Btn label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <Glyph d="M6.5 4.5h7 M6.5 8h7 M6.5 11.5h7 M2.5 3.5l1-.5v3 M2.5 9.2c.3-.5 1.7-.6 1.7.3 0 .6-1.7 1.3-1.7 2h1.8" />
      </Btn>
      <Btn label="Checklist" active={s.tasks} onClick={() => chain().toggleTaskList().run()}>
        <Glyph d="M2.5 3.5h3v3h-3z M3.2 5l.7.7 1.2-1.4 M8 5h5.5 M2.5 9.5h3v3h-3z M8 11h5.5" />
      </Btn>
      <Btn label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Glyph d="M3 5.5h3.5v3.5H4.5c0 1.2.6 2 2 2.2 M9.5 5.5H13v3.5h-2c0 1.2.6 2 2 2.2" />
      </Btn>
      <Btn label="Divider" onClick={() => chain().setHorizontalRule().run()}>
        <Glyph d="M2.5 8h11" />
      </Btn>
      <LinkMenu editor={editor} active={s.link} />

      {insert && (
        <>
          <Sep />
          <InsertMenu editor={editor} page={page} />
        </>
      )}

      {s.table && (
        <>
          <Sep />
          <span className="tb-group" aria-label="Table">
            <button type="button" className="tb-text" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addRowAfter().run()}>
              + Row
            </button>
            <button type="button" className="tb-text" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().addColumnAfter().run()}>
              + Column
            </button>
            <button type="button" className="tb-text" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteRow().run()}>
              − Row
            </button>
            <button type="button" className="tb-text" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteColumn().run()}>
              − Column
            </button>
            <button type="button" className="tb-text danger" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().deleteTable().run()}>
              Delete table
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/** + button: every macro, the same list "/" shows. */
function InsertMenu({ editor, page }: { editor: Editor; page: PageContext | null }) {
  const { open, setOpen, root } = usePopover();
  const items = INSERT_ITEMS.filter((i) => (i.id !== "image" && i.id !== "children") || page);
  return (
    <div className="tb-pop" ref={root}>
      <button
        type="button"
        className="tb-btn tb-insert"
        aria-label="Insert"
        aria-expanded={open}
        title="Insert (or type / in the text)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Glyph d="M8 3v10 M3 8h10" /> <span>Insert</span>
      </button>
      {open && (
        <div className="tb-menu slash-menu tb-insert-menu" role="menu" aria-label="Insert">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="slash-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                item.run(editor, page);
              }}
            >
              <Icon name={item.icon} />
              <span className="slash-text">
                <span>{item.label}</span>
                <span className="muted small">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const BLOCKS: { value: string; label: string }[] = [
  { value: "p", label: "Text" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
  { value: "code", label: "Code block" },
];

/** Paragraph or heading level, as a menu so the editor keeps its selection. */
function BlockMenu({ block, editor }: { block: string; editor: Editor }) {
  const { open, setOpen, root } = usePopover();
  const pick = (v: string) => {
    const chain = editor.chain().focus();
    if (v === "p") chain.setParagraph().run();
    else if (v === "code") chain.toggleCodeBlock().run();
    else chain.toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
    setOpen(false);
  };
  return (
    <div className="tb-pop" ref={root}>
      <button
        type="button"
        className="tb-block"
        aria-label="Text style"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {BLOCKS.find((b) => b.value === block)?.label ?? "Text"} <Glyph d="M5 6.5l3 3 3-3" />
      </button>
      {open && (
        <div className="tb-menu" role="listbox" aria-label="Text style">
          {BLOCKS.map((b) => (
            <button
              key={b.value}
              type="button"
              role="option"
              aria-selected={b.value === block}
              className="menu-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sep() {
  return <span className="tb-sep" aria-hidden="true" />;
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Btn({
  label,
  kbd,
  active,
  onClick,
  children,
}: {
  label: string;
  kbd?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tb-btn"
      aria-label={label}
      aria-pressed={active ?? undefined}
      title={kbd ? `${label} (${kbd})` : label}
      // Keep the editor's selection when clicking toolbar buttons.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  // A menu near the right edge opens leftwards instead of running off the window.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = root.current?.querySelector<HTMLElement>(".tb-menu");
    if (!menu) return;
    menu.removeAttribute("data-align");
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) menu.setAttribute("data-align", "right");
  }, [open]);
  return { open, setOpen, root };
}

function ColorMenu({
  label,
  swatches,
  current,
  preview,
  onPick,
}: {
  label: string;
  swatches: { label: string; value: string }[];
  current: string | null;
  preview: ReactNode;
  onPick: (color: string | null) => void;
}) {
  const { open, setOpen, root } = usePopover();
  return (
    <div className="tb-pop" ref={root}>
      <button
        type="button"
        className="tb-btn"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {preview}
      </button>
      {open && (
        <div className="tb-menu" role="listbox" aria-label={label}>
          <div className="swatches">
            {swatches.map((c) => (
              <button
                key={c.value}
                type="button"
                role="option"
                aria-selected={current?.toLowerCase() === c.value}
                aria-label={c.label}
                title={c.label}
                className="swatch"
                style={{ background: c.value }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(c.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="menu-item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            Remove {label.toLowerCase()}
          </button>
        </div>
      )}
    </div>
  );
}

function LinkMenu({ editor, active }: { editor: Editor; active: boolean }) {
  const { open, setOpen, root } = usePopover();
  const [url, setUrl] = useState("");

  const apply = () => {
    const v = url.trim();
    if (!v) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else {
      const href = /^(https?:|mailto:)/i.test(v) ? v : `https://${v}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setOpen(false);
  };

  return (
    <div className="tb-pop" ref={root}>
      <Btn
        label="Link"
        active={active}
        onClick={() => {
          setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
          setOpen(!open);
        }}
      >
        <Glyph d="M6.5 9.5l3-3 M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1 M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />
      </Btn>
      {open && (
        <div className="tb-menu tb-link">
          <input
            className="field"
            autoFocus
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <button type="button" className="ghost" onClick={apply}>
            {url.trim() ? "Apply" : "Remove link"}
          </button>
        </div>
      )}
    </div>
  );
}
