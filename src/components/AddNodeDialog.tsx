import { useEffect, useRef } from "react";
import type { ItemKind } from "../lib/session";
import { Icon, type IconName } from "./Icon";

const OPTIONS: { kind: ItemKind; label: string; detail: string; icon: IconName }[] = [
  { kind: "note", label: "Note", detail: "Write with headings, lists, and code.", icon: "note" },
  { kind: "whiteboard", label: "Whiteboard", detail: "Place text and shapes, connect them with arrows.", icon: "whiteboard" },
  { kind: "tracker", label: "Project", detail: "Track tasks on a board, backlog, and roadmap.", icon: "project" },
];

interface Props {
  /** Folder the item goes into, for the heading. Null means the top level. */
  folderName: string | null;
  onPick: (kind: ItemKind) => void;
  onClose: () => void;
}

export function AddNodeDialog({ folderName, onPick, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // No close() in cleanup: React's dev double-mount would fire onClose and
    // dismiss the dialog immediately. Unmounting removes it from the top layer anyway.
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="add-node-title"
      onClose={onClose}
      // Clicks on the backdrop land on the <dialog> element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <h2 id="add-node-title">{folderName ? `New page in ${folderName}` : "New page"}</h2>
      <div className="options">
        {OPTIONS.map((o, i) => (
          <button
            key={o.kind}
            className="option"
            autoFocus={i === 0}
            onClick={() => onPick(o.kind)}
          >
            <Icon name={o.icon} className="option-icon" />
            <span className="option-text">
              <span className="option-label">{o.label}</span>
              <span className="option-detail">{o.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </dialog>
  );
}
