// Blocks beyond plain markdown, like Confluence macros: code blocks with
// highlighting, images, panels, expands, child pages, and a table of contents.
// Each is stored in the note's markdown in a readable form:
//
//   ```rust                         code block
//   ![alt](att:<id>)                image stored in the doc
//   :::panel {type="warning"}       panel (closes with :::)
//   :::expand {title="Details"}     expand (closes with :::)
//   :::children {depth="all"} :::   child pages
//   :::toc :::                      table of contents
import { useEffect, useMemo, useState } from "react";
import {
  createAtomBlockMarkdownSpec,
  createBlockMarkdownSpec,
  Extension,
  Node,
  mergeAttributes,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type Editor,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Image from "@tiptap/extension-image";
import { createLowlight, common } from "lowlight";
import powershell from "highlight.js/lib/languages/powershell";
import x86asm from "highlight.js/lib/languages/x86asm";
import armasm from "highlight.js/lib/languages/armasm";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import verilog from "highlight.js/lib/languages/verilog";
import vhdl from "highlight.js/lib/languages/vhdl";
import llvm from "highlight.js/lib/languages/llvm";
import type { TreeNode } from "../lib/api";
import type { WorkspaceSession } from "../lib/session";
import { useTree } from "../lib/useTree";
import { copy } from "../lib/clipboard";
import { Icon, type IconName } from "../components/Icon";
import { ATTACHMENT_PREFIX, pickImageFile, prepareImage } from "./images";

/** What macros need from the page they're on. */
export interface PageContext {
  session: WorkspaceSession;
  /** The doc attachments are stored in: the note, or a task's project. */
  docId: string;
  /** The page whose children "Child pages" lists. */
  pageId: string;
  onOpen: (id: string) => void;
  onError: (err: unknown) => void;
}

// ---- code blocks ---------------------------------------------------------------------

const lowlight = createLowlight(common);
lowlight.register({ powershell, x86asm, armasm, dockerfile, nginx, verilog, vhdl, llvm });

export const LANGUAGES: { value: string; label: string }[] = [
  ["armasm", "ARM assembly"], ["bash", "Bash"], ["c", "C"], ["cpp", "C++"], ["csharp", "C#"],
  ["css", "CSS"], ["diff", "Diff"], ["dockerfile", "Dockerfile"], ["go", "Go"], ["graphql", "GraphQL"],
  ["xml", "HTML / XML"], ["ini", "INI / TOML"], ["java", "Java"], ["javascript", "JavaScript"],
  ["json", "JSON"], ["kotlin", "Kotlin"], ["llvm", "LLVM IR"], ["lua", "Lua"], ["makefile", "Makefile"],
  ["markdown", "Markdown"], ["nginx", "Nginx"], ["objectivec", "Objective-C"], ["perl", "Perl"],
  ["php", "PHP"], ["powershell", "PowerShell"], ["python", "Python"], ["r", "R"], ["ruby", "Ruby"],
  ["rust", "Rust"], ["shell", "Shell session"], ["sql", "SQL"], ["swift", "Swift"],
  ["typescript", "TypeScript"], ["verilog", "Verilog"], ["vhdl", "VHDL"], ["x86asm", "x86 assembly"],
  ["yaml", "YAML"],
].map(([value, label]) => ({ value, label }));

/**
 * The handle that moves a block: shows at the block's left edge on hover, and
 * dragging it carries the whole block (ProseMirror reads `data-drag-handle`).
 */
export function Grip({ editor }: { editor: ReactNodeViewProps["editor"] }) {
  if (!editor.isEditable) return null;
  return (
    <span className="block-grip" data-drag-handle contentEditable={false} title="Drag to move (or Alt+↑ / Alt+↓)" aria-hidden="true">
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
        <circle cx="3" cy="3" r="1.3" /><circle cx="7" cy="3" r="1.3" />
        <circle cx="3" cy="8" r="1.3" /><circle cx="7" cy="8" r="1.3" />
        <circle cx="3" cy="13" r="1.3" /><circle cx="7" cy="13" r="1.3" />
      </svg>
    </span>
  );
}

function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);
  // "Copied" resets after a moment; not after the block is gone.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  const language = (node.attrs.language as string | null) ?? "";
  const known = LANGUAGES.some((l) => l.value === language);
  return (
    <NodeViewWrapper className="code-block">
      <Grip editor={editor} />
      <div className="code-head" contentEditable={false}>
        {editor.isEditable ? (
          <select
            className="code-lang"
            aria-label="Language"
            value={language}
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
          >
            <option value="">Plain text</option>
            {!known && language && <option value={language}>{language}</option>}
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="code-lang">{LANGUAGES.find((l) => l.value === language)?.label ?? (language || "Plain text")}</span>
        )}
        <button
          type="button"
          className="code-copy"
          onClick={() =>
            copy(node.textContent, null).then(setCopied)
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend({
  draggable: true,
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
  addKeyboardShortcuts() {
    // Enter on a blank last line and ArrowDown at the end come from the base
    // extension; Escape leaves from anywhere, like panels and expands.
    return { ...this.parent?.(), Escape: exitBlock(this.name) };
  },
}).configure({ lowlight, defaultLanguage: null });

// ---- images --------------------------------------------------------------------------

/** Pasted images being stored, so a remount doesn't store one twice. */
const converting = new Set<string>();

/** Image data that lives only in this window, like a paste WebKit turned into a blob: URL. */
const isLocalData = (src: string) => src.startsWith("blob:") || src.startsWith("data:image/");

function ImageView({ node, extension, selected, editor, updateAttributes }: ReactNodeViewProps) {
  const ctx = (extension.options as { page: PageContext | null }).page;
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const isAttachment = src.startsWith(ATTACHMENT_PREFIX);

  // Some webviews paste images straight into the page as blob: or data: URLs,
  // which would be gone on reload. Store those in the doc like any other image.
  useEffect(() => {
    if (!ctx || !editor.isEditable || !isLocalData(src) || converting.has(src)) return;
    converting.add(src);
    (async () => {
      const blob = await (await fetch(src)).blob();
      const prepared = await prepareImage(new File([blob], alt || "Pasted image", { type: blob.type }));
      const id = await ctx.session.addAttachment(ctx.docId, prepared);
      // Not tied to this render: React may remount the view while this runs.
      if (!editor.isDestroyed) {
        try {
          updateAttributes({ src: `${ATTACHMENT_PREFIX}${id}`, alt: alt || "Pasted image" });
        } catch {
          // the image was removed in the meantime
        }
      }
    })().catch(ctx.onError);
  }, [ctx, editor, src, alt, updateAttributes]);

  useEffect(() => {
    if (!isAttachment || !ctx) return;
    let live = true;
    ctx.session.attachmentUrl(ctx.docId, src.slice(ATTACHMENT_PREFIX.length)).then(
      (u) => {
        if (!live) return;
        setUrl(u);
        setMissing(!u);
      },
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [ctx, src, isAttachment]);

  return (
    <NodeViewWrapper className="image-block" data-selected={selected || undefined}>
      <Grip editor={editor} />
      {isLocalData(src) && ctx && editor.isEditable ? (
        <div className="image-blocked" contentEditable={false}>
          Adding image…
        </div>
      ) : !isAttachment ? (
        // Images from the web are never loaded: a shared note could use one to
        // learn when and where you opened it.
        <div className="image-blocked" contentEditable={false}>
          <Icon name="shield" /> Web image not loaded: <span className="muted">{src}</span>
        </div>
      ) : url ? (
        <img src={url} alt={alt} draggable={false} />
      ) : (
        <div className="image-blocked" contentEditable={false}>
          {missing ? "This image hasn't arrived yet, or was removed." : "Loading image…"}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const AttachmentImage = Image.extend<{ page: PageContext | null }>({
  draggable: true,
  addOptions() {
    return { ...this.parent?.(), page: null } as never;
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

/** Store an image file and insert it at the selection (or `pos`). */
export async function insertImage(editor: Editor, page: PageContext, file: File, pos?: number) {
  try {
    const prepared = await prepareImage(file);
    const id = await page.session.addAttachment(page.docId, prepared);
    const content = { type: "image", attrs: { src: `${ATTACHMENT_PREFIX}${id}`, alt: prepared.name.replace(/\.\w+$/, "") } };
    const chain = editor.chain().focus();
    (pos === undefined ? chain.insertContent(content) : chain.insertContentAt(pos, content)).run();
  } catch (e) {
    page.onError(e);
  }
}

export async function chooseImage(editor: Editor, page: PageContext) {
  const file = await pickImageFile();
  if (file) await insertImage(editor, page, file);
}

/** Pasted and dropped image files become attachments. */
export const ImageInput = Extension.create<{ page: PageContext | null }>({
  name: "imageInput",
  addOptions() {
    return { page: null };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const page = this.options.page;
    const images = (files: FileList | undefined | null) =>
      [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
    // Image files on the clipboard, wherever the webview puts them: as files,
    // as file items, or (WebKitGTK) as HTML with a local blob: or data: URL.
    const pastedImages = async (data: DataTransfer): Promise<File[]> => {
      const files = images(data.files);
      if (files.length) return files;
      const items = [...data.items]
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (items.length) return items;
      const html = data.getData("text/html");
      const srcs = [...html.matchAll(/<img[^>]+src="((?:blob|data):[^"]+)"/gi)].map((m) => m[1]);
      const out: File[] = [];
      for (const src of srcs) {
        const blob = await (await fetch(src)).blob();
        if (blob.type.startsWith("image/")) out.push(new File([blob], "Pasted image", { type: blob.type }));
      }
      return out;
    };
    const looksLikeImagePaste = (data: DataTransfer) =>
      images(data.files).length > 0 ||
      [...data.items].some((i) => i.kind === "file" && i.type.startsWith("image/")) ||
      /<img[^>]+src="(?:blob|data):/i.test(data.getData("text/html"));
    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData;
            if (!data || !page || !editor.isEditable || !looksLikeImagePaste(data)) return false;
            event.preventDefault();
            pastedImages(data).then(
              (files) => files.forEach((f) => insertImage(editor, page, f)),
              page.onError,
            );
            return true;
          },
          handleDrop: (view, event) => {
            const files = images((event as DragEvent).dataTransfer?.files);
            if (!files.length || !page || !editor.isEditable) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            files.forEach((f) => insertImage(editor, page, f, at));
            return true;
          },
        },
      }),
    ];
  },
});

/** Enter on an empty last line inside a panel or expand steps out below it. */
/**
 * Leave the nearest enclosing `name` block: the cursor lands on the line just
 * below it, a new empty one when the block is the last thing in the note (or
 * in whatever holds it). `onlyAtEnd` limits it to when the cursor is already
 * at the block's very end, for ArrowDown; Escape works from anywhere inside.
 */
function exitBlock(name: string, onlyAtEnd = false) {
  return ({ editor }: { editor: Editor }) => {
    const { $from, empty } = editor.state.selection;
    if (!empty) return false;
    let depth = -1;
    for (let d = $from.depth; d >= 1; d--) {
      if ($from.node(d).type.name === name) {
        depth = d;
        break;
      }
    }
    if (depth < 0) return false;
    if (onlyAtEnd) {
      // At the end of the current line, and that line is the last one at
      // every level between it and the block.
      if ($from.parentOffset !== $from.parent.content.size) return false;
      for (let d = $from.depth; d > depth; d--) {
        if ($from.index(d - 1) !== $from.node(d - 1).childCount - 1) return false;
      }
    }
    return editor
      .chain()
      .command(({ tr }) => {
        const after = $from.after(depth);
        const next = tr.doc.nodeAt(after);
        if (next && next.type.name === "paragraph") {
          tr.setSelection(TextSelection.create(tr.doc, after + 1));
        } else {
          tr.insert(after, editor.schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, after + 1));
        }
        tr.scrollIntoView();
        return true;
      })
      .run();
  };
}

function exitOnEmptyEnter(name: string) {
  return ({ editor }: { editor: Editor }) => {
    const { $from, empty } = editor.state.selection;
    if (!empty || $from.depth < 2) return false;
    const line = $from.parent;
    const depth = $from.depth - 1;
    const box = $from.node(depth);
    if (box.type.name !== name || line.type.name !== "paragraph" || line.content.size > 0) return false;
    if ($from.index(depth) !== box.childCount - 1 || box.childCount < 2) return false;
    return editor
      .chain()
      .command(({ tr }) => {
        const start = $from.before();
        tr.delete(start, start + line.nodeSize);
        const at = tr.mapping.map($from.after(depth));
        tr.insert(at, editor.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, at + 1));
        return true;
      })
      .run();
  };
}

// ---- panels --------------------------------------------------------------------------

export const PANEL_TYPES: { value: string; label: string; icon: IconName }[] = [
  { value: "info", label: "Info", icon: "bookmark" },
  { value: "note", label: "Note", icon: "note" },
  { value: "warning", label: "Warning", icon: "flag" },
  { value: "success", label: "Success", icon: "check" },
  { value: "error", label: "Error", icon: "bug" },
];

function PanelView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const type = PANEL_TYPES.find((p) => p.value === node.attrs.type) ?? PANEL_TYPES[0];
  return (
    <NodeViewWrapper className="panel" data-type={type.value}>
      <Grip editor={editor} />
      <span className="panel-icon" contentEditable={false}>
        {editor.isEditable ? (
          <select
            className="panel-type"
            aria-label="Panel type"
            title="Panel type"
            value={type.value}
            onChange={(e) => updateAttributes({ type: e.target.value })}
          >
            {PANEL_TYPES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        ) : null}
        <Icon name={type.icon} />
      </span>
      <NodeViewContent className="panel-body" />
    </NodeViewWrapper>
  );
}

export const Panel = Node.create({
  name: "panel",
  group: "block",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      type: {
        default: "info",
        parseHTML: (el) => el.getAttribute("data-type") ?? "info",
        renderHTML: (a) => ({ "data-type": a.type }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-panel]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-panel": "" }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(PanelView);
  },
  addKeyboardShortcuts() {
    return {
      Enter: exitOnEmptyEnter(this.name),
      Escape: exitBlock(this.name),
      ArrowDown: exitBlock(this.name, true),
    };
  },
  ...createBlockMarkdownSpec({
    nodeName: "panel",
    defaultAttributes: { type: "info" },
    allowedAttributes: ["type"],
  }),
});

// ---- expand --------------------------------------------------------------------------

/** Titles live in a `{title="…"}` attribute, so quotes and braces are left out. */
const cleanTitle = (t: string) => t.replace(/["{}\n]/g, "").slice(0, 200);

function ExpandView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  // Closed when reading; a new, empty one opens so you can fill it in.
  const [open, setOpen] = useState(() => editor.isEditable && node.textContent === "");
  const title = String(node.attrs.title ?? "");
  return (
    <NodeViewWrapper className="expand" data-open={open || undefined}>
      <Grip editor={editor} />
      <div className="expand-head" contentEditable={false}>
        <button type="button" className="expand-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron" className={open ? "chev open" : "chev"} />
        </button>
        {editor.isEditable ? (
          <input
            className="expand-title"
            value={title}
            placeholder="Click to expand"
            aria-label="Expand title"
            onChange={(e) => updateAttributes({ title: cleanTitle(e.target.value) })}
          />
        ) : (
          <button type="button" className="expand-title" onClick={() => setOpen(!open)}>
            {title || "Click to expand"}
          </button>
        )}
      </div>
      <NodeViewContent className="expand-body" />
    </NodeViewWrapper>
  );
}

export const Expand = Node.create({
  name: "expand",
  group: "block",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? "",
        renderHTML: (a) => ({ "data-title": a.title }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-expand]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-expand": "" }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ExpandView);
  },
  addKeyboardShortcuts() {
    return {
      Enter: exitOnEmptyEnter(this.name),
      Escape: exitBlock(this.name),
      ArrowDown: exitBlock(this.name, true),
    };
  },
  ...createBlockMarkdownSpec({
    nodeName: "expand",
    allowedAttributes: ["title"],
  }),
});

// ---- child pages ---------------------------------------------------------------------

const KIND_ICON: Record<string, IconName> = { note: "note", whiteboard: "whiteboard", tracker: "project", folder: "folder" };

function ChildList({
  parent,
  children,
  all,
  onOpen,
}: {
  parent: string;
  children: Map<string | null, TreeNode[]>;
  all: boolean;
  onOpen: (id: string) => void;
}) {
  const kids = children.get(parent) ?? [];
  if (!kids.length) return null;
  return (
    <ul>
      {kids.map((n) => (
        <li key={n.id}>
          {n.kind === "folder" ? (
            <span className="child-link">
              <Icon name="folder" /> {n.title || "Untitled folder"}
            </span>
          ) : (
            <button type="button" className="child-link" onClick={() => onOpen(n.id)}>
              <Icon name={KIND_ICON[n.kind] ?? "note"} /> {n.title || "Untitled"}
            </button>
          )}
          {all && <ChildList parent={n.id} children={children} all onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

function ChildrenView({ node, updateAttributes, editor, extension }: ReactNodeViewProps) {
  const page = (extension.options as { page: PageContext | null }).page;
  const all = node.attrs.depth === "all";
  return (
    <NodeViewWrapper className="macro children-macro" contentEditable={false}>
      <Grip editor={editor} />
      <div className="macro-head">
        <Icon name="folder" /> Child pages
        {editor.isEditable && (
          <select
            className="macro-option"
            aria-label="How deep"
            value={all ? "all" : "1"}
            onChange={(e) => updateAttributes({ depth: e.target.value })}
          >
            <option value="1">Direct children</option>
            <option value="all">All descendants</option>
          </select>
        )}
      </div>
      {page ? <ChildPages page={page} all={all} /> : <p className="muted small">Only available in pages.</p>}
    </NodeViewWrapper>
  );
}

function ChildPages({ page, all }: { page: PageContext; all: boolean }) {
  const tree = useTree(page.session, page.onError);
  const has = (tree.children.get(page.pageId)?.length ?? 0) > 0;
  return has ? (
    <ChildList parent={page.pageId} children={tree.children} all={all} onOpen={page.onOpen} />
  ) : (
    <p className="muted small">No pages inside this one yet. Add one from the sidebar with + on this page.</p>
  );
}

export const ChildPagesMacro = Node.create<{ page: PageContext | null }>({
  name: "children",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { page: null };
  },
  addAttributes() {
    return {
      depth: {
        default: "1",
        parseHTML: (el) => el.getAttribute("data-depth") ?? "1",
        renderHTML: (a) => ({ "data-depth": a.depth }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-children-macro]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-children-macro": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ChildrenView);
  },
  ...createAtomBlockMarkdownSpec({ nodeName: "children", allowedAttributes: ["depth"] }),
});

// ---- table of contents -------------------------------------------------------------------

function TocView({ editor }: ReactNodeViewProps) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const out: { level: number; text: string; pos: number }[] = [];
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === "heading") out.push({ level: n.attrs.level as number, text: n.textContent, pos });
        return n.type.name !== "heading";
      });
      return JSON.stringify(out);
    },
  });
  const list = useMemo(() => JSON.parse(headings) as { level: number; text: string; pos: number }[], [headings]);
  const top = Math.min(...list.map((h) => h.level), 3);

  const jump = (pos: number) => {
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    dom?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <NodeViewWrapper className="macro toc-macro" contentEditable={false}>
      <Grip editor={editor} />
      <div className="macro-head">
        <Icon name="view" /> Contents
      </div>
      {list.length ? (
        <ul>
          {list.map((h) => (
            <li key={h.pos} style={{ paddingLeft: `${(h.level - top) * 1}rem` }}>
              <button type="button" className="child-link" onClick={() => jump(h.pos)}>
                {h.text || "Untitled heading"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Add headings and they'll be listed here.</p>
      )}
    </NodeViewWrapper>
  );
}

export const TocMacro = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toc": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TocView);
  },
  ...createAtomBlockMarkdownSpec({ nodeName: "toc" }),
});
