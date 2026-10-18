import { useEffect, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { TreeNode } from "../lib/api";
import { ancestors, useTree } from "../lib/useTree";
import type { DropRef, ItemKind, WorkspaceSession } from "../lib/session";
import { AddNodeDialog } from "./AddNodeDialog";
import { Icon, type IconName } from "./Icon";
import { useCanEdit } from "../lib/access";
import { isPinned, usePins } from "../lib/pins";
import { PinButton } from "./PinnedNav";
import { RailSection } from "./RailSection";
import { showToast } from "../lib/toast";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { MoveDialog } from "./MoveDialog";
import type { WorkspaceInfo } from "../lib/api";

interface Props {
  session: WorkspaceSession;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onError: (err: unknown) => void;
  /** After a move to another workspace: open that workspace, optionally at the moved page. */
  onOpenWorkspace?: (id: string, item?: string | null) => void;
}

type DropPos = "before" | "after" | "inside";
type DropTarget = { id: string; pos: DropPos } | { root: true } | null;

const KIND_ICON: Record<Exclude<TreeNode["kind"], "folder">, IconName> = {
  note: "note",
  whiteboard: "whiteboard",
  tracker: "project",
};

export function Tree({ session, selectedId, onOpen, onError, onOpenWorkspace }: Props) {
  const canEdit = useCanEdit();
  const menu = useContextMenu();
  const [moving, setMoving] = useState<TreeNode | null>(null);
  const tree = useTree(session, onError);
  const { nodes, byId, children } = tree;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  // undefined: dialog closed. null: adding at the top level. string: adding into that folder.
  const [addingTo, setAddingTo] = useState<string | null | undefined>(undefined);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);

  // Show the open page, even when it's nested inside collapsed pages or folders.
  useEffect(() => {
    if (!selectedId) return;
    const up = ancestors(tree, selectedId).map((n) => n.id);
    if (up.length) setExpanded((s) => (up.every((id) => s.has(id)) ? s : new Set([...s, ...up])));
  }, [selectedId, tree]);

  const hasKids = (id: string) => (children.get(id)?.length ?? 0) > 0;
  const pins = usePins(session.id);
  const [flash, setFlash] = useState<string | null>(null);

  // A pinned folder was clicked: open it and everything above it, and show it.
  useEffect(() => {
    const reveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const up = [...ancestors(tree, id).map((n) => n.id), id];
      setExpanded((s) => new Set([...s, ...up]));
      setFlash(id);
      requestAnimationFrame(() => document.querySelector(`[data-node="${id}"]`)?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("reveal-node", reveal);
    return () => window.removeEventListener("reveal-node", reveal);
  }, [tree]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  const expand = (id: string) => setExpanded((s) => new Set(s).add(id));
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const run = (p: Promise<unknown>) => p.catch(onError);

  const addItem = async (kind: ItemKind) => {
    const parent = addingTo ?? null;
    setAddingTo(undefined);
    if (parent) expand(parent);
    try {
      onOpen(await session.createItem(kind, parent));
    } catch (e) {
      onError(e);
    }
  };

  const newFolder = async (parent: string | null) => {
    if (parent) expand(parent);
    try {
      setRenaming(await session.createFolder(parent));
    } catch (e) {
      onError(e);
    }
  };

  /** Deletes right away; the toast offers Undo for a few seconds. */
  const deleteNode = async (n: TreeNode) => {
    const label = n.title || (n.kind === "folder" ? "Untitled folder" : "Untitled");
    try {
      const removed = await session.deleteNode(n.id);
      const inside = Object.keys(removed).length - 1;
      showToast(inside > 0 ? `Deleted “${label}” and ${inside} item${inside === 1 ? "" : "s"} inside it` : `Deleted “${label}”`, {
        action: { label: "Undo", run: () => run(session.restoreNodes(removed)) },
      });
    } catch (e) {
      onError(e);
    }
  };

  /** Everything under a node, for the move dialog's count. */
  const countInside = (id: string): number => (children.get(id) ?? []).reduce((n, c) => n + 1 + countInside(c.id), 0);

  const rowMenu = (n: TreeNode): MenuItem[] => {
    const isFolder = n.kind === "folder";
    if (!canEdit) return [];
    return [
      { label: "New page inside", onSelect: () => setAddingTo(n.id) },
      ...(isFolder
        ? [
            { label: "New subfolder", onSelect: () => newFolder(n.id) },
            { label: "Rename", onSelect: () => setRenaming(n.id) },
          ]
        : []),
      { label: "Move to another workspace…", onSelect: () => setMoving(n), separator: true },
      { label: isFolder || hasKids(n.id) ? "Delete with everything inside" : "Delete", onSelect: () => deleteNode(n), danger: true, separator: true },
    ];
  };

  const onMoved = (n: TreeNode, target: WorkspaceInfo, firstId: string | null) => {
    const label = n.title || (n.kind === "folder" ? "Untitled folder" : "Untitled");
    showToast(`Moved “${label}” to ${target.name}`, onOpenWorkspace ? { action: { label: "Open", run: () => onOpenWorkspace(target.id, firstId) } } : {});
  };

  // ---- drag and drop ----------------------------------------------------------

  /** Where a drop on `target` at `pos` would put the dragged node, or null if not allowed. */
  const resolve = (target: TreeNode, pos: DropPos): { parent: string | null; ref: DropRef } | null => {
    if (!dragId || target.id === dragId) return null;
    const parent = pos === "inside" ? target.id : target.parent;
    if (parent && session.isWithin(parent, dragId)) return null; // into itself
    const ref: DropRef =
      pos === "inside" ? { end: true } : pos === "before" ? { before: target.id } : { after: target.id };
    return { parent, ref };
  };

  const onRowDragOver = (e: DragEvent, n: TreeNode) => {
    if (!dragId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    // Anything can hold children: the middle of a row drops inside it. An open
    // node's bottom edge sits above its children, so "after" there would
    // mislead; treat the whole lower part as "inside" instead.
    const openWithChildren = expanded.has(n.id) && hasKids(n.id);
    const pos: DropPos = y < 0.25 ? "before" : y > 0.75 && !openWithChildren ? "after" : "inside";
    if (!resolve(n, pos)) {
      setDrop(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (!drop || !("id" in drop) || drop.id !== n.id || drop.pos !== pos) setDrop({ id: n.id, pos });
  };

  const onRowDrop = (e: DragEvent, n: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = drop && "id" in drop && drop.id === n.id ? drop.pos : null;
    const target = pos && resolve(n, pos);
    const moving = dragId;
    endDrag();
    if (!target || !moving) return;
    if (pos === "inside") expand(n.id);
    run(session.moveNode(moving, target.parent, target.ref));
  };

  const onRootDragOver = (e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!drop || !("root" in drop)) setDrop({ root: true });
  };

  const onRootDrop = (e: DragEvent) => {
    e.preventDefault();
    const moving = dragId;
    endDrag();
    if (moving) run(session.moveNode(moving, null, { end: true }));
  };

  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  // ---- render -----------------------------------------------------------------

  const render = (parent: string | null, depth: number) =>
    (children.get(parent) ?? []).map((n) => (
      <li
        key={n.id}
        role="treeitem"
        aria-expanded={n.kind === "folder" || hasKids(n.id) ? expanded.has(n.id) : undefined}
      >
        <Row
          node={n}
          depth={depth}
          hasChildren={hasKids(n.id)}
          pinned={isPinned(pins, { kind: "node", id: n.id })}
          workspace={session.id}
          flash={flash === n.id}
          open={expanded.has(n.id)}
          selected={n.id === selectedId}
          renaming={renaming === n.id}
          dragging={dragId === n.id}
          drop={drop && "id" in drop && drop.id === n.id ? drop.pos : null}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", n.id);
            setDragId(n.id);
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => onRowDragOver(e, n)}
          onDrop={(e) => onRowDrop(e, n)}
          onClick={() => (n.kind === "folder" ? toggle(n.id) : onOpen(n.id))}
          onToggle={() => toggle(n.id)}
          onRename={(title) => {
            setRenaming(null);
            if (title && title !== n.title) run(session.renameFolder(n.id, title));
          }}
          onStartRename={() => setRenaming(n.id)}
          onAdd={() => setAddingTo(n.id)}
          onNewFolder={() => newFolder(n.id)}
          onDelete={() => deleteNode(n)}
          onContextMenu={(e) => menu.open(e, rowMenu(n))}
        />
        {(n.kind === "folder" || hasKids(n.id)) && expanded.has(n.id) && (
          <ul role="group">{render(n.id, depth + 1)}</ul>
        )}
      </li>
    ));

  return (
    <RailSection
      id="pages"
      className="pages-nav"
      title="Pages"
      actions={
        canEdit ? (
          <>
            <button className="tool" title="New folder" aria-label="New folder" onClick={() => newFolder(null)}>
              <Icon name="folder" />
            </button>
            <button className="tool" title="New page" aria-label="New page" onClick={() => setAddingTo(null)}>
              <Icon name="plus" />
            </button>
          </>
        ) : (
          <span className="tool" title="View only" aria-label="View only">
            <Icon name="eye" />
          </span>
        )
      }
    >
    <nav className="tree" aria-label="Workspace contents">
      {nodes.length === 0 ? (
        <p className="tree-empty">{canEdit ? "No pages yet. Add one with +." : "No pages yet."}</p>
      ) : (
        <ul role="tree">{render(null, 0)}</ul>
      )}

      {/* Dropping on the empty space below the tree moves to the top level. */}
      <div
        className="tree-tail"
        data-drop={drop && "root" in drop ? "root" : undefined}
        onDragOver={onRootDragOver}
        onDragLeave={() => drop && "root" in drop && setDrop(null)}
        onDrop={onRootDrop}
      />

      {menu.menu}
      {moving && (
        <MoveDialog
          session={session}
          id={moving.id}
          label={moving.title || (moving.kind === "folder" ? "Untitled folder" : "Untitled")}
          inside={countInside(moving.id)}
          onMoved={(target, firstId) => onMoved(moving, target, firstId)}
          onError={onError}
          onClose={() => setMoving(null)}
        />
      )}
      {addingTo !== undefined && (
        <AddNodeDialog
          folderName={addingTo ? byId.get(addingTo)?.title || "folder" : null}
          onPick={addItem}
          onClose={() => setAddingTo(undefined)}
        />
      )}
    </nav>
    </RailSection>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  /** Has pages or folders inside it. */
  hasChildren: boolean;
  pinned: boolean;
  workspace: string;
  /** Briefly highlighted, after a pinned folder is revealed. */
  flash: boolean;
  open: boolean;
  selected: boolean;
  renaming: boolean;
  dragging: boolean;
  drop: DropPos | null;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onClick: () => void;
  onToggle: () => void;
  onRename: (title: string) => void;
  onStartRename: () => void;
  onAdd: () => void;
  onNewFolder: () => void;
  onDelete: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}

function Row(p: RowProps) {
  const canEdit = useCanEdit();
  const isFolder = p.node.kind === "folder";
  const label = p.node.title || (isFolder ? "Untitled folder" : "Untitled");

  return (
    <div
      className="row"
      data-node={p.node.id}
      data-flash={p.flash || undefined}
      data-selected={p.selected || undefined}
      data-dragging={p.dragging || undefined}
      data-drop={p.drop ?? undefined}
      data-missing={p.node.missing || undefined}
      title={p.node.missing ? "Waiting for this page to arrive from the device it was made on" : undefined}
      style={{ paddingLeft: `${0.25 + p.depth * 0.875}rem` }}
      draggable={canEdit && !p.renaming}
      onContextMenu={p.onContextMenu}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
    >
      <span className="twisty">
        {(isFolder || p.hasChildren) && (
          <button
            className="twisty-btn"
            aria-label={p.open ? `Collapse ${label}` : `Expand ${label}`}
            onClick={p.onToggle}
          >
            <Icon name="chevron" className={p.open ? "chev open" : "chev"} />
          </button>
        )}
      </span>
      {p.renaming ? (
        <input
          className="row-input"
          autoFocus
          defaultValue={p.node.title}
          aria-label="Folder name"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => p.onRename(e.currentTarget.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") p.onRename("");
          }}
        />
      ) : (
        <button
          className="row-main"
          onClick={p.onClick}
          onDoubleClick={isFolder && canEdit ? p.onStartRename : undefined}
        >
          <Icon name={isFolder ? "folder" : KIND_ICON[p.node.kind as keyof typeof KIND_ICON]} className="kind" />
          <span className="row-label">{label}</span>
        </button>
      )}

      <div className="row-tools">
        <PinButton workspace={p.workspace} pin={{ kind: "node", id: p.node.id }} pinned={p.pinned} />
        {canEdit && <>
        <button
          className="tool"
          title={isFolder ? "Add node to folder" : "Add a page inside"}
          aria-label={isFolder ? "Add node to folder" : `Add a page inside ${label}`}
          onClick={p.onAdd}
        >
          <Icon name="plus" />
        </button>
        {isFolder && (
          <>
            <button className="tool" title="New subfolder" aria-label="New subfolder" onClick={p.onNewFolder}>
              <Icon name="folder" />
            </button>
            <button className="tool" title="Rename" aria-label="Rename folder" onClick={p.onStartRename}>
              <Icon name="pencil" />
            </button>
          </>
        )}
        <button
          className="tool"
          title={isFolder || p.hasChildren ? "Delete with everything inside (undo from the message)" : "Delete (undo from the message)"}
          aria-label={`Delete ${label}`}
          onClick={p.onDelete}
        >
          <Icon name="trash" />
        </button>
      </>}
      </div>
    </div>
  );
}
