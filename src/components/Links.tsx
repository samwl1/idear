import { useContext, useMemo } from "react";
import type { EntityKind, LinkRef, Links } from "../lib/api";
import type { WorkspaceSession } from "../lib/session";
import { NavContext, useOpenRef } from "../lib/nav";
import { useLinkTargets, useLinks } from "../lib/useLinks";
import { ItemPicker } from "./ItemPicker";
import { Icon, type IconName } from "./Icon";
import { useCanEdit } from "../lib/access";

export const KIND_ICON: Record<EntityKind, IconName> = {
  note: "note",
  whiteboard: "whiteboard",
  tracker: "project",
  folder: "folder",
  task: "check",
  phase: "flag",
};

/** Text for a link chip: task keys up front, phases and tasks with their project. */
export function refLabel(ref: LinkRef): { title: string; detail: string | null } {
  if (!ref.kind) return { title: "Deleted item", detail: null };
  const title = ref.kind === "task" && ref.key ? `${ref.key} ${ref.title}` : ref.title || "Untitled";
  const detail = ref.kind === "task" || ref.kind === "phase" ? (ref.trackerTitle ? `in ${ref.trackerTitle}` : null) : null;
  return { title, detail };
}

/** One linked item as a small chip that opens it. */
export function LinkChip({
  link,
  from,
  onRemove,
}: {
  link: LinkRef;
  /** The link points here from this item, rather than the other way round. */
  from?: boolean;
  onRemove?: () => void;
}) {
  const open = useOpenRef();
  const canEdit = useCanEdit();
  const { title, detail } = refLabel(link);
  const kindTip = link.kind ? `${from ? "Links here: " : ""}${title}${detail ? ` ${detail}` : ""}` : "This item was deleted";
  return (
    <span className="link-chip" data-missing={!link.kind || undefined} data-from={from || undefined} title={kindTip}>
      <button className="link-chip-main" disabled={!link.kind} onClick={() => open(link)}>
        <Icon name={link.kind ? KIND_ICON[link.kind] : "note"} />
        <span className="link-chip-title">{title}</span>
        {detail && <span className="link-chip-detail">{detail}</span>}
      </button>
      {onRemove && canEdit && (
        <button className="link-chip-x" aria-label={`Unlink ${title}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Everything a note or whiteboard is linked with: what it's attached to
 * (removable) and what links to it from elsewhere, like a task's links or a
 * whiteboard card.
 */
export function ItemLinks({
  session,
  itemId,
  links,
  compact,
  onError,
}: {
  session: WorkspaceSession;
  itemId: string;
  /** Pass when already loaded (the Notes Hub); otherwise fetched here. */
  links?: Links | null;
  compact?: boolean;
  onError: (err: unknown) => void;
}) {
  const fetched = useLinks(session, itemId, onError);
  const data = links ?? fetched;
  const targets = useLinkTargets(session, onError);
  const run = (p: Promise<unknown>) => p.catch(onError);

  const linked = new Set(data?.outgoing.map((l) => l.id));
  const options = useMemo(
    () =>
      targets
        .filter((t) => t.id !== itemId && !linked.has(t.id))
        .map((t) => [t.id, { title: t.title, detail: t.detail }] as [string, { title: string; detail: string }]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, itemId, data],
  );

  // Incoming links that duplicate an outgoing one (linked both ways) show once.
  const incoming = data?.incoming.filter((l) => !linked.has(l.id)) ?? [];

  return (
    <div className="links-row">
      {data?.outgoing.map((l) => (
        <LinkChip key={`o:${l.id}`} link={l} onRemove={() => run(session.unlinkItem(itemId, l.id))} />
      ))}
      {incoming.map((l) => (
        <LinkChip key={`i:${l.id}`} link={l} from />
      ))}
      <ItemPicker
        items={options}
        compact={compact}
        label="Link to…"
        placeholder="Find an item, task, or phase"
        onPick={(id) => run(session.linkItem(itemId, id))}
      />
    </div>
  );
}

/** @deprecated Use ItemLinks. */
export const NoteLinks = ({ noteId, ...rest }: { session: WorkspaceSession; noteId: string; links?: Links | null; compact?: boolean; onError: (err: unknown) => void }) => (
  <ItemLinks itemId={noteId} {...rest} />
);

/**
 * Notes and whiteboards attached to an item, task, or phase, with a picker
 * to attach an existing one or start a new note already attached. Tasks also
 * list the items they point at themselves (`extra`), removable the same way.
 */
export function References({
  session,
  targetId,
  label = "Add reference",
  extra,
  onError,
}: {
  session: WorkspaceSession;
  targetId: string;
  label?: string;
  /** Outgoing links the target holds itself (a task's `links`), with how to change them. */
  extra?: { ids: string[]; onChange: (ids: string[]) => void };
  onError: (err: unknown) => void;
}) {
  const { openItem } = useContext(NavContext);
  const links = useLinks(session, targetId, onError);
  const targets = useLinkTargets(session, onError);
  const run = (p: Promise<unknown>) => p.catch(onError);

  // A note or whiteboard counts as attached when it links here.
  const attached = links?.incoming.filter((l) => l.kind === "note" || l.kind === "whiteboard") ?? [];
  const have = new Set([...attached.map((n) => n.id), ...(extra?.ids ?? [])]);
  const byId = new Map(targets.map((t) => [t.id, t]));
  const options = targets
    .filter((t) => t.id !== targetId && !have.has(t.id) && (extra ? t.kind !== "task" && t.kind !== "phase" : t.kind === "note" || t.kind === "whiteboard"))
    .map((t) => [t.id, { title: t.title, detail: t.detail }] as [string, { title: string; detail: string }]);

  return (
    <div className="links-row">
      {attached.map((n) => (
        <LinkChip key={n.id} link={n} onRemove={() => run(session.unlinkItem(n.id, targetId))} />
      ))}
      {extra?.ids.map((id) => {
        const t = byId.get(id);
        const link: LinkRef = t
          ? { id, kind: t.kind, title: t.title, tracker: t.tracker, trackerTitle: null, key: null }
          : { id, kind: null, title: "", tracker: null, trackerTitle: null, key: null };
        return <LinkChip key={`x:${id}`} link={link} onRemove={() => extra.onChange(extra.ids.filter((x) => x !== id))} />;
      })}
      <ItemPicker
        items={options}
        label={label}
        placeholder={extra ? "Find a note, whiteboard, or project, or name a new note" : "Find a note or whiteboard, or name a new note"}
        onPick={(id) => {
          const t = byId.get(id);
          if (t && (t.kind === "note" || t.kind === "whiteboard")) run(session.linkItem(id, targetId));
          else if (extra) extra.onChange([...extra.ids, id]);
        }}
        onCreate={{
          label: (typed) => (typed ? `New note "${typed}"` : "New note"),
          run: (typed) => {
            session.createAttached("note", targetId, typed || undefined).then((id) => openItem(id), onError);
          },
        }}
      />
    </div>
  );
}

/** @deprecated Use References. */
export const AttachedNotes = References;
