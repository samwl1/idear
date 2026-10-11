import { createContext, useContext } from "react";
import type { LinkRef } from "./api";
import type { SettingsTab } from "../components/settings/SettingsPage";

export interface OpenOptions {
  /** For projects: a task to open in the drawer. */
  task?: string;
  /** For projects: which tab to show. */
  tab?: "board" | "backlog" | "phases" | "roadmap";
}

export interface Nav {
  openItem: (id: string, opts?: OpenOptions) => void;
  /** Open a Help topic (see src/help/docs.ts), optionally at a section. */
  openHelp: (doc: string, anchor?: string | null) => void;
  /** Open a Settings tab ("claude", "devices", ...). */
  openSettings: (tab: SettingsTab) => void;
}

export const NavContext = createContext<Nav>({ openItem: () => {}, openHelp: () => {}, openSettings: () => {} });

/** Open whatever a link points at: an item, a task in its project, or a phase on its roadmap. */
export function useOpenRef() {
  const { openItem } = useContext(NavContext);
  return (ref: Pick<LinkRef, "id" | "kind" | "tracker">) => {
    if (!ref.kind) return;
    if (ref.kind === "task" && ref.tracker) openItem(ref.tracker, { task: ref.id });
    else if (ref.kind === "phase" && ref.tracker) openItem(ref.tracker, { tab: "phases" });
    else openItem(ref.id);
  };
}

export const useNav = () => useContext(NavContext);
