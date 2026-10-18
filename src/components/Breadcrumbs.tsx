import { useContext } from "react";
import { NavContext } from "../lib/nav";
import type { WorkspaceSession } from "../lib/session";
import { ancestors, useTree } from "../lib/useTree";

/** Where a page sits: its folders and parent pages, top level first. */
export function Breadcrumbs({
  session,
  id,
  onError,
  omitCurrent,
}: {
  session: WorkspaceSession;
  id: string;
  onError: (err: unknown) => void;
  /** Just the folders and pages above this one, when the title is shown elsewhere. */
  omitCurrent?: boolean;
}) {
  const tree = useTree(session, onError);
  const { openItem } = useContext(NavContext);
  const path = ancestors(tree, id);
  const title = tree.byId.get(id)?.title || "Untitled";
  // The whole path as a tooltip, for when the bar is too narrow to show it.
  const full = [...path.map((n) => n.title || (n.kind === "folder" ? "Untitled folder" : "Untitled")), ...(omitCurrent ? [] : [title])].join(" / ");
  return (
    <nav className="crumbs" aria-label="Location" title={full}>
      {path.map((n, i) => (
        <span key={n.id} className="crumb">
          {n.kind === "folder" ? (
            <span>{n.title || "Untitled folder"}</span>
          ) : (
            <button className="link-btn" onClick={() => openItem(n.id)}>
              {n.title || "Untitled"}
            </button>
          )}
          {(!omitCurrent || i < path.length - 1) && (
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
          )}
        </span>
      ))}
      {!omitCurrent && <span className="crumb crumb-current" aria-current="page">{title}</span>}
    </nav>
  );
}
