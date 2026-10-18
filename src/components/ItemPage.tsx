import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { MarkdownEditor, Toolbar } from "./MarkdownEditor";
import { OutlineRail } from "./OutlineRail";
import { Breadcrumbs } from "./Breadcrumbs";
import { PinButton } from "./PinnedNav";
import { isPinned, usePins } from "../lib/pins";
import { ItemLinks, References } from "./Links";
import { PopOutButton } from "./PopOutButton";
import { A } from "../lib/automerge";
import type { ItemBase, ItemKind, Note, Whiteboard, WorkspaceSession } from "../lib/session";
import { useDebounced } from "../lib/useDebounced";
import { Board } from "../whiteboard/Board";
import { TrackerPage } from "../tracker/TrackerPage";
import type { TrackerDoc } from "../tracker/model";
import { useCanEdit } from "../lib/access";
import { showToast } from "../lib/toast";

interface Props {
  session: WorkspaceSession;
  id: string;
  kind: ItemKind;
  /** For projects: a task to open on arrival. */
  task?: string;
  /** For projects: a tab to show on arrival. */
  tab?: "board" | "backlog" | "phases" | "roadmap";
  /** Changes on every open, so reopening jumps to the task or tab again. */
  at?: number;
  onOpen: (id: string) => void;
  onError: (err: unknown) => void;
}

/** Loads the item doc, then renders its header and body. Keyed by id in the parent. */
export function ItemPage({ session, id, kind, task, tab, at, onOpen, onError }: Props) {
  const [doc, setDoc] = useState<ItemBase | null>(null);
  // The tree lists the page but its content hasn't reached this device.
  const [missing, setMissing] = useState(false);
  const editor = useRef<Editor | null>(null);
  // The note's editor, for the toolbar in the top bar.
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
  const canEdit = useCanEdit();
  const page = useMemo(() => ({ session, docId: id, pageId: id, onOpen, onError }), [session, id, onOpen, onError]);
  // Stable, or the editor would hand itself over (and take itself back) on every render.
  const onEditor = useCallback((e: Editor | null) => {
    editor.current = e;
    setLiveEditor(e);
  }, []);

  // Notes remount on a remote change (the parent keys them by version);
  // projects stay mounted and follow live, so their header needs the doc
  // reloaded here when another device changes it.
  const remoteVersion = session.remoteVersion(id);
  useEffect(() => {
    let live = true;
    session.loadItem(id).then(
      (d) => live && setDoc(d),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [session, id, onError, remoteVersion]);

  if (missing) return <MissingPage session={session} id={id} onError={onError} />;
  if (!doc) return <div className="editor-loading" aria-busy="true" />;

  if (kind === "whiteboard") {
    return (
      <article className="board-page">
        <Board
          session={session}
          id={id}
          initial={(doc as Whiteboard).elements}
          onOpen={onOpen}
          onError={onError}
          header={(aside) => <ItemHeader session={session} id={id} kind={kind} initial={doc} onError={onError} onEnter={() => {}} top={false} aside={aside} />}
        />
      </article>
    );
  }

  if (kind === "tracker") {
    return (
      <TrackerPage
        session={session}
        id={id}
        initial={doc as unknown as TrackerDoc}
        task={task}
        tab={tab}
        at={at}
        onOpenItem={onOpen}
        onError={onError}
        header={(aside) => <ItemHeader session={session} id={id} kind={kind} initial={doc} onError={onError} onEnter={() => {}} top={false} aside={aside} />}
      />
    );
  }

  return (
    <div className="note-page">
      <ItemTop session={session} id={id} onError={onError}>
        {canEdit && liveEditor && <Toolbar editor={liveEditor} page={page} insert />}
      </ItemTop>
    <div className="note-layout">
    <article className="editor">
      <ItemHeader
        session={session}
        id={id}
        kind={kind}
        initial={doc}
        onError={onError}
        onEnter={() => editor.current?.commands.focus("start")}
        top={false}
      />
      <NoteBody
        session={session}
        id={id}
        initial={(doc as Note).body}
        onOpen={onOpen}
        onError={onError}
        onEditor={onEditor}
      />
    </article>
    <OutlineRail editor={liveEditor} />
    </div>
    </div>
  );
}

/** The slim bar above an item: where it is, and the pin. */
function ItemTop({
  session,
  id,
  onError,
  children,
}: {
  session: WorkspaceSession;
  id: string;
  onError: (err: unknown) => void;
  /** Sits in the middle of the bar: the note's formatting toolbar. */
  children?: ReactNode;
}) {
  const pins = usePins(session.id);
  return (
    <div className="item-top">
      <Breadcrumbs session={session} id={id} onError={onError} />
      {children}
      <PinButton workspace={session.id} pin={{ kind: "node", id }} pinned={isPinned(pins, { kind: "node", id })} />
      <PopOutButton session={session} id={id} />
    </div>
  );
}

export function ItemHeader({
  session,
  id,
  kind,
  initial,
  onError,
  onEnter,
  top = true,
  aside,
}: {
  session: WorkspaceSession;
  id: string;
  kind: ItemKind;
  initial: ItemBase;
  onError: (err: unknown) => void;
  onEnter: () => void;
  /** Include the breadcrumb bar (notes render it outside the editor column). */
  top?: boolean;
  /** Sits to the right of the title: a project's location, pin, and Git button. */
  aside?: ReactNode;
}) {
  const [title, setTitle] = useState(initial.title);
  const [tags, setTags] = useState<string[]>([...initial.tags]);
  const [draftTag, setDraftTag] = useState("");
  // A rename or tag change from another device arrives as a new `initial`;
  // follow it unless this device is mid-edit of the same field.
  const editingTitle = useRef(false);
  useEffect(() => {
    if (!editingTitle.current) setTitle(initial.title);
  }, [initial.title]);
  const tagKey = initial.tags.join("\n");
  useEffect(() => {
    setTags(tagKey ? tagKey.split("\n") : []);
  }, [tagKey]);
  // A fresh item lands with its title selected, ready to type over.
  const canEdit = useCanEdit();
  const [isFresh] = useState(() => canEdit && initial.title.startsWith("Untitled") && !(initial as Note).body);

  const saveTitle = useDebounced((t: string) => {
    session.changeItem(id, "rename", (d) => A.updateText(d, ["title"], t)).catch(onError);
  }, 400);

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    setDraftTag("");
    if (!tag || tags.includes(tag)) return;
    setTags([...tags, tag]);
    session.changeItem(id, "tag", (d) => void d.tags.push(tag)).catch(onError);
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
    session
      .changeItem(id, "tag", (d) => {
        const i = d.tags.indexOf(tag);
        if (i >= 0) d.tags.splice(i, 1);
      })
      .catch(onError);
  };

  return (
    <>
      {top && <ItemTop session={session} id={id} onError={onError} />}
      <div className="title-row">
      <span className="title-fit" data-aside={aside ? true : undefined}>
      {/* A hidden copy of the text sizes the box, so a long title wraps onto
          more lines instead of being cut off; the field is laid over it. */}
      <span className="title-sizer" aria-hidden="true">
        {title || "Untitled"}
        {"\u200b"}
      </span>
      <textarea
        className="note-title"
        rows={1}
        autoFocus={isFresh}
        onFocus={(e) => {
          editingTitle.current = true;
          if (isFresh) e.currentTarget.select();
        }}
        onBlur={() => {
          editingTitle.current = false;
        }}
        value={title}
        readOnly={!canEdit}
        placeholder="Untitled"
        aria-label="Title"
        onChange={(e) => {
          // Titles are one line; a pasted newline becomes a space.
          const v = e.target.value.replace(/[\r\n]+/g, " ");
          setTitle(v);
          saveTitle(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      </span>
      {aside && <div className="title-aside">{aside}</div>}
      </div>

      <div className="item-meta">
      <div className="tags">
        <span className="item-links-label">Tags:</span>
        {tags.map((t) => (
          <span className="tag" key={t}>
            {t}
            {canEdit && (
              <button aria-label={`Remove tag ${t}`} onClick={() => removeTag(t)}>
                ×
              </button>
            )}
          </span>
        ))}
        {canEdit && <input
          className="tag-input"
          value={draftTag}
          placeholder="+ tag"
          aria-label="Add tag"
          onChange={(e) => setDraftTag(e.target.value)}
          onBlur={() => addTag(draftTag)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(draftTag);
            }
            if (e.key === "Backspace" && !draftTag && tags.length) {
              removeTag(tags[tags.length - 1]);
            }
          }}
        />}
      </div>
      <div className="item-links">
        <span className="item-links-label">References:</span>
        {kind === "note" || kind === "whiteboard" ? (
          <ItemLinks session={session} itemId={id} onError={onError} />
        ) : (
          <References session={session} targetId={id} onError={onError} />
        )}
      </div>
      </div>
    </>
  );
}

function NoteBody({
  session,
  id,
  initial,
  onOpen,
  onError,
  onEditor,
}: {
  session: WorkspaceSession;
  id: string;
  initial: string;
  onOpen: (id: string) => void;
  onError: (err: unknown) => void;
  onEditor: (e: Editor | null) => void;
}) {
  const page = useMemo(() => ({ session, docId: id, pageId: id, onOpen, onError }), [session, id, onOpen, onError]);
  return (
    <MarkdownEditor
      initial={initial}
      label="Note body"
      page={page}
      toolbar={false}
      onEditor={onEditor}
      onChange={(md) =>
        session.changeItem<Note>(id, "edit", (d) => A.updateText(d, ["body"], md)).catch(onError)
      }
    />
  );
}

/** A page another device made whose content hasn't synced here yet. */
function MissingPage({ session, id, onError }: { session: WorkspaceSession; id: string; onError: (err: unknown) => void }) {
  const title = String(session.node(id)?.title ?? "Untitled");
  const remove = async () => {
    try {
      const removed = await session.deleteNode(id);
      showToast(`Removed “${title}”`, { action: { label: "Undo", run: () => session.restoreNodes(removed).catch(onError) } });
    } catch (e) {
      onError(e);
    }
  };
  return (
    <article className="missing-page">
      <h1>{title}</h1>
      <p>
        This page was made on another device and its content hasn't reached this one yet. It will open once that device syncs.
      </p>
      <p>If it was deleted there before it synced, you can remove it from the sidebar.</p>
      <button type="button" className="ghost" onClick={remove}>
        Remove from sidebar
      </button>
    </article>
  );
}
