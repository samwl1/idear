// The color and icon of each workspace, as last seen. The workspace itself is
// the source of truth (session.look()); this cache lets the switcher draw the
// other workspaces in the list without opening them.
import type { WorkspaceLook } from "./session";
import type { IconName } from "../components/Icon";

export const LOOK_COLORS: { value: string; label: string }[] = [
  { value: "indigo", label: "Indigo" },
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "green", label: "Green" },
  { value: "yellow", label: "Yellow" },
  { value: "orange", label: "Orange" },
  { value: "red", label: "Red" },
  { value: "pink", label: "Pink" },
  { value: "violet", label: "Violet" },
  { value: "grey", label: "Grey" },
];

export const LOOK_ICONS: IconName[] = [
  "note", "book", "folder", "project", "whiteboard", "star", "flag", "bolt", "heart", "target",
  "shield", "bug", "tag", "users", "link", "clock", "inbox", "sparkle", "pin", "search",
];

export function rememberLook(id: string, look: WorkspaceLook) {
  try {
    localStorage.setItem(`look:${id}`, JSON.stringify(look));
  } catch {
    // storage unavailable: the list falls back to initials
  }
}

export function cachedLook(id: string): WorkspaceLook {
  try {
    return (JSON.parse(localStorage.getItem(`look:${id}`) ?? "null") as WorkspaceLook | null) ?? {};
  } catch {
    return {};
  }
}
