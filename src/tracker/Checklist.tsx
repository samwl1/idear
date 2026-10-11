// A task's checklist: tick items off, rename them in place, add more.
import { useState } from "react";
import type { ChecklistItem } from "./model";
import { Icon } from "../components/Icon";

interface Props {
  items: ChecklistItem[];
  canEdit: boolean;
  onAdd: (text: string) => void;
  onEdit: (id: string, patch: { done?: boolean; text?: string | null }) => void;
}

export function Checklist({ items, canEdit, onAdd, onEdit }: Props) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const done = items.filter((i) => i.done).length;

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft("");
  };

  return (
    <div className="checklist">
      {items.length > 0 && (
        <div className="checklist-bar" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-label="Checklist progress">
          <span style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
        </div>
      )}
      <ul className="checklist-items">
        {items.map((item) => (
          <li key={item.id} className="checklist-item" data-done={item.done || undefined}>
            <input
              type="checkbox"
              checked={item.done}
              disabled={!canEdit}
              aria-label={item.text}
              onChange={(e) => onEdit(item.id, { done: e.target.checked })}
            />
            {editing === item.id ? (
              <input
                className="field checklist-edit"
                autoFocus
                defaultValue={item.text}
                aria-label="Item text"
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  setEditing(null);
                  if (!v) onEdit(item.id, { text: null });
                  else if (v !== item.text) onEdit(item.id, { text: v });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.currentTarget.value = item.text;
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <span
                className="checklist-text"
                onDoubleClick={() => canEdit && setEditing(item.id)}
                title={canEdit ? "Double-click to edit" : undefined}
              >
                {item.text}
              </span>
            )}
            {canEdit && editing !== item.id && (
              <span className="checklist-tools">
                <button type="button" className="tool" aria-label="Edit item" title="Edit" onClick={() => setEditing(item.id)}>
                  <Icon name="pencil" />
                </button>
                <button type="button" className="tool" aria-label="Remove item" title="Remove" onClick={() => onEdit(item.id, { text: null })}>
                  <Icon name="trash" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="checklist-add">
          <Icon name="plus" />
          <input
            className="checklist-add-input"
            value={draft}
            placeholder={items.length ? "Add an item" : "Add a step to tick off"}
            aria-label="New checklist item"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </div>
      )}
    </div>
  );
}
