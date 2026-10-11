import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, type ViewRow } from "../lib/api";
import type { WorkspaceSession } from "../lib/session";
import { movePin, pinKey, setPinnedSettings, togglePin, usePinnedSettings, usePins, type Pin } from "../lib/pins";
import { useTree } from "../lib/useTree";
import { Icon, VIEW_ICONS, iconName, type IconName } from "./Icon";
import { RailSection } from "./RailSection";

const KIND_ICON: Record<string, IconName> = { note: "note", whiteboard: "whiteboard", tracker: "project", folder: "folder" };

interface Props {
  session: WorkspaceSession;
  activeKey: string | null;
  onOpen: (pin: Pin) => void;
  onError: (err: unknown) => void;
}

/** Everything pinned in this workspace. Hidden while nothing is. */
export function PinnedNav({ session, activeKey, onOpen, onError }: Props) {
  const pins = usePins(session.id);
  const settings = usePinnedSettings();
  const tree = useTree(session, onError);
  const tasks = usePinnedTasks(session, pins, onError);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  if (!pins.length) return null;

  const label = (p: Pin): { title: string; icon: IconName; missing: boolean } => {
    switch (p.kind) {
      case "hub":
        return { title: "Notes Hub", icon: "note", missing: false };
      case "activity":
        return { title: "Activity", icon: "log", missing: false };
      case "view": {
        const v = session.view(p.id);
        return { title: v?.name || "Untitled view", icon: iconName(v?.icon), missing: !v };
      }
      case "node": {
        const n = tree.byId.get(p.id);
        return { title: n?.title || (n?.kind === "folder" ? "Untitled folder" : "Untitled"), icon: KIND_ICON[n?.kind ?? "note"], missing: !n && tree.nodes.length > 0 };
      }
      case "task": {
        const t = tasks.get(p.id);
        return { title: t ? `${t.key ?? ""} ${t.title || "Untitled task"}`.trim() : "Task", icon: "check", missing: tasks.size > 0 && !t };
      }
    }
  };

  const drop = (e: DragEvent, before: string | null) => {
    e.preventDefault();
    if (dragging) movePin(session.id, dragging, before);
    setDragging(null);
    setOver(null);
  };

  return (
    <RailSection
      id="pinned"
      className="pinned-nav"
      title={settings.name || "Pinned"}
      icon={<Icon name={settings.icon} />}
      actions={<PinnedSettingsMenu />}
    >
      <ul onDragOver={(e) => dragging && e.preventDefault()} onDrop={(e) => drop(e, null)}>
        {pins.map((p) => {
          const key = pinKey(p);
          const l = label(p);
          return (
            <li
              key={key}
              className="pin-row"
              draggable
              data-dragging={dragging === key || undefined}
              data-drop={(over === key && dragging !== key) || undefined}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key);
                setDragging(key);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.stopPropagation();
                if (over !== key) setOver(key);
              }}
              onDrop={(e) => {
                e.stopPropagation();
                drop(e, key);
              }}
            >
              <button
                className="nav-item"
                data-active={activeKey === key || undefined}
                data-missing={l.missing || undefined}
                disabled={l.missing}
                title={l.missing ? "This was deleted" : l.title}
                onClick={() => onOpen(p)}
              >
                <Icon name={l.icon} /> <span className="row-label">{l.title}</span>
              </button>
              <button className="tool pin-x" aria-label={`Unpin ${l.title}`} title="Unpin" onClick={() => togglePin(session.id, p)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </RailSection>
  );
}

/** Titles and keys for pinned tasks, kept current. */
function usePinnedTasks(session: WorkspaceSession, pins: Pin[], onError: (err: unknown) => void) {
  const [rows, setRows] = useState<ViewRow[]>([]);
  const wanted = pins.some((p) => p.kind === "task");
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const refresh = () =>
      api
        .runView(session.id, { types: ["task"], tags: [], text: "", updatedWithinDays: null, sort: "title", statuses: [], assignee: "", keys: [] })
        .then((r) => live && setRows(r), onError);
    refresh();
    const off = session.subscribe(refresh);
    return () => {
      live = false;
      off();
    };
  }, [session, wanted, onError]);
  return useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
}

/** Rename the section and pick its icon. */
function PinnedSettingsMenu() {
  const settings = usePinnedSettings();
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

  return (
    <div className="pinned-menu" ref={root}>
      <button className="tool" aria-label="Section settings" aria-expanded={open} title="Name and icon" onClick={() => setOpen(!open)}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div className="menu menu-settings pinned-settings" role="dialog" aria-label="Pinned section settings">
          <label className="setting">
            <span>Name</span>
            <input
              className="field"
              autoFocus
              defaultValue={settings.name}
              maxLength={40}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setPinnedSettings({ ...settings, name: e.target.value })}
              onBlur={(e) => !e.currentTarget.value.trim() && setPinnedSettings({ ...settings, name: "Pinned" })}
              onKeyDown={(e) => e.key === "Enter" && setOpen(false)}
            />
          </label>
          <div className="setting">
            <span>Icon</span>
            <div className="icon-grid inline" role="radiogroup" aria-label="Section icon">
              {VIEW_ICONS.map((name) => (
                <button
                  key={name}
                  role="radio"
                  aria-checked={name === settings.icon}
                  aria-label={name}
                  onClick={() => setPinnedSettings({ ...settings, icon: name })}
                >
                  <Icon name={name} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small toggle for pinning whatever's on screen. */
export function PinButton({ workspace, pin, pinned }: { workspace: string; pin: Pin; pinned: boolean }) {
  return (
    <button
      className="tool pin-toggle"
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin" : "Pin"}
      title={pinned ? "Unpin" : "Pin to the sidebar"}
      onClick={() => togglePin(workspace, pin)}
    >
      <Icon name="pin" />
    </button>
  );
}
