// "Move to another workspace": pick one of your other editable workspaces and
// the page (or folder, with everything inside) goes to its top level.
import { useEffect, useRef, useState } from "react";
import { api, canEditRole, type WorkspaceInfo } from "../lib/api";
import { WorkspaceSession } from "../lib/session";
import { cachedLook } from "../lib/looks";
import { carryPins } from "../lib/pins";
import { WorkspaceMark } from "./WorkspaceSwitcher";

interface Props {
  session: WorkspaceSession;
  /** The node to move, and what to call it. */
  id: string;
  label: string;
  /** Pages, folders, and projects inside it, for the heading. */
  inside: number;
  onMoved: (target: WorkspaceInfo, firstId: string | null) => void;
  onError: (err: unknown) => void;
  onClose: () => void;
}

export function MoveDialog({ session, id, label, inside, onMoved, onError, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [targets, setTargets] = useState<WorkspaceInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    api.listWorkspaces().then(
      (list) => live && setTargets(list.filter((w) => w.id !== session.id && canEditRole(w.role))),
      onError,
    );
    return () => {
      live = false;
    };
  }, [session.id, onError]);

  const move = async (w: WorkspaceInfo) => {
    setBusy(true);
    try {
      const ids = await moveSubtree(session, id, w);
      onMoved(w, ids[id] ?? null);
      onClose();
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="move-title" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <h2 id="move-title">Move “{label}” to…</h2>
      {inside > 0 && (
        <p className="muted small">
          Everything inside it ({inside} item{inside === 1 ? "" : "s"}) comes along. Links to pages that stay behind are dropped.
        </p>
      )}
      {targets === null ? (
        <p className="muted small">Loading…</p>
      ) : targets.length === 0 ? (
        <p className="muted small">No other workspace you can edit. Make one under Settings → Workspaces.</p>
      ) : (
        <div className="options" aria-busy={busy || undefined}>
          {targets.map((w, i) => (
            <button key={w.id} className="option" autoFocus={i === 0} disabled={busy} onClick={() => move(w)}>
              <WorkspaceMark name={w.name} look={cachedLook(w.id)} />
              <span className="option-text">
                <span className="option-label">{w.name}</span>
                <span className="option-detail">{w.role === "owner" ? (w.shared ? "Yours, shared" : "Yours") : `Editor · ${w.ownerName || "someone else"}'s`}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </dialog>
  );
}

/**
 * Copies `id` and everything under it into `target`'s top level, then removes
 * it here. The copy is finished before anything is removed, so a failure
 * part-way leaves the pages where they were (and possibly a partial copy to
 * clean up in the other workspace). Returns the ids there, old to new.
 */
export async function moveSubtree(from: WorkspaceSession, id: string, target: WorkspaceInfo): Promise<Record<string, string>> {
  const sub = await from.exportSubtree(id);
  const to = await WorkspaceSession.open(target.id);
  to.setCanEdit(canEditRole(target.role));
  const ids = await to.importSubtree(null, sub, "tree.move_in");
  await from.deleteNode(id, "tree.move_out");
  await carryPins(from, to, ids);
  return ids;
}
