import { useEffect, useRef, useState } from "react";
import type { WorkspaceInfo } from "../lib/api";
import { Icon, iconName } from "./Icon";
import type { WorkspaceLook } from "../lib/session";
import { cachedLook } from "../lib/looks";

interface Props {
  current: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  /** The open workspace's color and icon. */
  look: WorkspaceLook;
  /** Settings, Workspaces: rename, color and icon, sharing, delete, restore, and the full list. */
  onManage: () => void;
  /** Hide the whole sidebar. */
  onCollapse: () => void;
}

/** A small marker for workspaces other people are part of. */
function Badge({ w }: { w: WorkspaceInfo }) {
  if (w.role === "owner") return w.shared ? <span className="badge">Shared</span> : null;
  const text = w.role === "editor" ? "Editor" : w.role === "viewer" ? "View only" : "Removed";
  return (
    <span className="badge" data-role={w.role} title={w.ownerName ? `Owned by ${w.ownerName}` : undefined}>
      {text}
    </span>
  );
}

export function WorkspaceSwitcher({ current, workspaces, onSwitch, onCreate, look, onManage, onCollapse }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="switcher" ref={root}>
      <div className="switcher-row">
        <button className="switcher-current" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
          <WorkspaceMark name={current.name} look={look} />
          <span className="switcher-name">{current.name}</span>
          {(current.shared || current.role !== "owner") && (
            <span
              className="switcher-shared"
              title={
                current.role === "owner"
                  ? "Shared with other people"
                  : `${current.role === "viewer" ? "View only" : "Editor"}${current.ownerName ? `, owned by ${current.ownerName}` : ""}`
              }
            >
              <Icon name={current.role === "viewer" ? "eye" : "users"} />
            </span>
          )}
          <Icon name="chevron" className={open ? "chev down open" : "chev down"} />
        </button>
        <button
          className="tool rail-collapse"
          aria-label="Hide sidebar"
          title={`Hide sidebar (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}\\)`}
          onClick={onCollapse}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      {open && (
        <div className="switcher-menu" role="listbox" aria-label="Workspaces">
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="option"
              aria-selected={w.id === current.id}
              className="switcher-item"
              onClick={() => {
                setOpen(false);
                if (w.id !== current.id) onSwitch(w.id);
              }}
            >
              <WorkspaceMark name={w.name} look={w.id === current.id ? look : cachedLook(w.id)} small />
              <span className="switcher-item-name">{w.name}</span>
              <Badge w={w} />
              {w.id === current.id && <Icon name="check" />}
            </button>
          ))}
          <div className="switcher-sep" />
          {creating ? (
            <NameInput
              placeholder="Workspace name"
              onDone={(name) => {
                setCreating(false);
                setOpen(false);
                if (name) onCreate(name);
              }}
            />
          ) : (
            <button className="switcher-item" onClick={() => setCreating(true)}>
              <span>Add workspace</span>
              <Icon name="plus" />
            </button>
          )}
          <button
            className="switcher-item"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <span>Manage workspaces</span>
            <Icon name="gear" />
          </button>
        </div>
      )}
    </div>
  );
}

/** A colored square with the workspace's icon, or its initial. */
export function WorkspaceMark({ name, look, small }: { name: string; look: WorkspaceLook; small?: boolean }) {
  return (
    <span className="switcher-mark" data-color={look.color || "indigo"} data-small={small || undefined} aria-hidden="true">
      {look.icon ? <Icon name={iconName(look.icon)} /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function NameInput({
  placeholder,
  onDone,
  className = "switcher-input",
}: {
  placeholder: string;
  onDone: (name: string) => void;
  className?: string;
}) {
  return (
    <input
      className={className}
      autoFocus
      placeholder={placeholder}
      aria-label={placeholder}
      onBlur={(e) => onDone(e.currentTarget.value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") onDone("");
      }}
    />
  );
}
