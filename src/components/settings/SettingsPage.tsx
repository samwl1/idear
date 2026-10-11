import type { ReactNode } from "react";
import type { WorkspaceInfo } from "../../lib/api";
import { Icon, type IconName } from "../Icon";

export type SettingsTab = "workspaces" | "sharing" | "devices" | "claude" | "appearance" | "accessibility" | "help";

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: "workspaces", label: "Workspaces", icon: "folder" },
  { id: "sharing", label: "Sharing", icon: "users" },
  { id: "devices", label: "Devices", icon: "bolt" },
  { id: "claude", label: "Claude", icon: "sparkle" },
  { id: "appearance", label: "Appearance", icon: "eye" },
  { id: "accessibility", label: "Accessibility", icon: "target" },
  { id: "help", label: "Help", icon: "book" },
];

interface Props {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  /** Any workspace on this device, for the Sharing tab. Without one, Sharing is hidden. */
  current?: WorkspaceInfo;
  children: ReactNode;
}

/** Settings: tabs across the top, the chosen section below. */
export function SettingsPage({ tab, onTab, current, children }: Props) {
  const tabs = TABS.filter((t) => t.id !== "sharing" || current);
  return (
    <section className="settings" data-tab={tab}>
      <header className="settings-head">
        <h1>Settings</h1>
        <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls="settings-panel"
              tabIndex={t.id === tab ? 0 : -1}
              onClick={() => onTab(t.id)}
              onKeyDown={(e) => {
                const i = tabs.findIndex((x) => x.id === tab);
                const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                const next = tabs[(i + d + tabs.length) % tabs.length];
                onTab(next.id);
                requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus());
              }}
            >
              <Icon name={t.icon} /> {t.label}
              {t.id === "sharing" && current?.shared && <span className="badge">{current.role === "owner" ? "Shared" : current.role === "editor" ? "Editor" : "View only"}</span>}
            </button>
          ))}
        </nav>
      </header>
      <div className="settings-body" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {children}
      </div>
    </section>
  );
}
