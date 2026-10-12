// A handful of 16px stroke icons. Inline so the app has no icon dependency.
const paths = {
  chevron: "M6 4l4 4-4 4",
  note: "M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12",
  folder: "M2 4.5h4l1.5 1.5H14v7.5H2z",
  plus: "M8 3v10 M3 8h10",
  trash: "M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.7 9h5.6l.7-9",
  pencil: "M10.5 2.5l3 3-8 8H2.5v-3z",
  log: "M3 3.5h10 M3 6.5h10 M3 9.5h6 M3 12.5h4",
  check: "M3 8.5l3 3 7-7",
  whiteboard: "M2.5 3.5h11v8h-11z M5 14l3-2.5 3 2.5 M5 9l2-2.5 2 1.5 2-3",
  project: "M2.5 3h3v10h-3z M6.5 3h3v6h-3z M10.5 3h3v8h-3z",
  view: "M2.5 4h11 M4.5 8h7 M6.5 12h3",
  grip: "M6 4h.01 M10 4h.01 M6 8h.01 M10 8h.01 M6 12h.01 M10 12h.01",
  star: "M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1 4.6 12.9l.7-3.8L2.5 6.5l3.8-.5z",
  flag: "M3.5 14V2.5 M3.5 3h8l-1.5 3 1.5 3h-8",
  bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z",
  bookmark: "M4.5 2.5h7v11L8 11l-3.5 2.5z",
  inbox: "M2.5 9l2-5.5h7l2 5.5v4.5h-11z M2.5 9h3.5l.5 1.5h3l.5-1.5h3.5",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11 M8 5v3.2l2 1.3",
  shield: "M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z",
  bug: "M5.5 6.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0z M8 6.5v6 M5.5 8H3 M10.5 8H13 M5.5 11l-2 1.5 M10.5 11l2 1.5 M6 4.5L4.5 3 M10 4.5L11.5 3",
  target: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11 M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5 M8 8h.01",
  tag: "M2.5 2.5h5l6 6-5 5-6-6z M5.5 5.5h.01",
  heart: "M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5z",
  sidebar: "M2.5 3h11v10h-11z M6.5 3v10 M4 5.5h1 M4 7.5h1",
  popout: "M9 2.5h4.5V7 M13.5 2.5L7.5 8.5 M11 9.5v4H2.5V5h4",
  archive: "M2.5 3h11v3h-11z M3.5 6v7.5h9V6 M6.5 9h3",
  list: "M3 4.5h10 M3 8h10 M3 11.5h10",
  group: "M2.5 3h11v3.5h-11z M2.5 9.5h11V13h-11z",
  branch: "M4.5 3.5v9 M4.5 3.5a1.5 1.5 0 1 0 0-0.01 M4.5 12.5a1.5 1.5 0 1 0 0-0.01 M11.5 5a1.5 1.5 0 1 0 0-0.01 M11.5 6.5c0 3-7 2-7 5",
  globe: "M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2 M2 8h12 M8 2c-2 2-2 10 0 12 M8 2c2 2 2 10 0 12",
  pin: "M6 2.5h4 M7 2.5v4L4.5 9h7L9 6.5v-4 M8 9v4.5",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4",
  users: "M6 3a2.2 2.2 0 1 0 0 4.4A2.2 2.2 0 1 0 6 3 M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4 M10.5 3.2a2.2 2.2 0 0 1 0 4.2 M12 9.7c1.5.4 2.5 1.7 2.5 3.8",
  link: "M7 9a3 3 0 0 0 4.2 0l2-2A3 3 0 0 0 9 2.8l-1 1 M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l1-1",
  gear: "M14.3 9.2 L13.3 11.6 L11.6 11.3 L11.3 11.6 L11.6 13.3 L9.2 14.3 L8.3 12.9 L7.7 12.9 L6.8 14.3 L4.4 13.3 L4.7 11.6 L4.4 11.3 L2.7 11.6 L1.7 9.2 L3.1 8.3 L3.1 7.7 L1.7 6.8 L2.7 4.4 L4.4 4.7 L4.7 4.4 L4.4 2.7 L6.8 1.7 L7.7 3.1 L8.3 3.1 L9.2 1.7 L11.6 2.7 L11.3 4.4 L11.6 4.7 L13.3 4.4 L14.3 6.8 L12.9 7.7 L12.9 8.3z M8 5.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z",
  sparkle: "M8 1.8l1.3 4.1 4.1 1.3-4.1 1.3L8 12.6 6.7 8.5 2.6 7.2l4.1-1.3z M12.8 11.2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z",
  expand: "M9.5 2.5h4v4 M13.5 2.5L9 7 M6.5 13.5h-4v-4 M2.5 13.5L7 9",
  shrink: "M13.5 6.5h-4v-4 M9.5 6.5L14 2 M2.5 9.5h4v4 M6.5 9.5L2 14",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9 M10.3 10.3L14 14",
  cloud: "M4.5 12.5h7.5a2.5 2.5 0 0 0 .3-5A4 4 0 0 0 4.6 6.6a3 3 0 0 0-.1 5.9z",
  book: "M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 0 6.5 12h-4z M13.5 3h-4A1.5 1.5 0 0 0 8 4.5v9A1.5 1.5 0 0 1 9.5 12h4z",
} as const;

export type IconName = keyof typeof paths;

/** Icons a user can pick for a view. */
export const VIEW_ICONS: IconName[] = [
  "view", "star", "flag", "bolt", "bookmark", "inbox", "clock", "shield",
  "bug", "target", "tag", "heart", "book", "note", "whiteboard", "project",
  "pin", "folder", "users", "link",
];

/** Stored icon names come from user data; fall back if one isn't known. */
export function iconName(value: unknown): IconName {
  const s = value == null ? "" : String(value);
  return s in paths ? (s as IconName) : "view";
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
