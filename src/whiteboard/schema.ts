// The whiteboard's storage format. This is what lives in the Automerge doc, and
// it deliberately knows nothing about the canvas library. The adapter converts
// to and from it; swapping libraries means writing a new adapter, not migrating
// data. Rule: if a feature can't be expressed here, it doesn't go on the board.

export type Font = "hand" | "sans" | "serif" | "mono";
export type Align = "left" | "center" | "right";
export type Fill = "solid" | "hatch" | "cross-hatch" | "zigzag";
export type Stroke = "solid" | "dashed" | "dotted";

export interface Style {
  color: string; // stroke/text color, hex
  background: string; // hex, or "transparent"
  fill: Fill; // how the background is painted
  stroke: Stroke;
  width: number; // stroke width in px
  sketch: number; // 0 clean, 1 hand-drawn, 2 rough
  opacity: number; // 0..100
  rounded: boolean;
  font: Font;
  fontSize: number;
  align: Align;
}

interface Base {
  x: number;
  y: number;
  rotation: number; // radians
  z: string; // fractional index; lower draws first
  groups: string[];
  style: Style;
}

export interface BoxElement extends Base {
  type: "rect" | "ellipse" | "diamond";
  w: number;
  h: number;
  text: string;
}

export interface TextElement extends Base {
  type: "text";
  w: number;
  autoSize: boolean;
  text: string;
}

export interface FreehandElement extends Base {
  type: "freehand";
  /** Each stroke's points as "x,y x,y ..." in element-local coordinates. */
  strokes: { straight: boolean; points: string }[];
}

/** Where an arrow end is attached. `focus`/`gap` describe how it meets the target's edge. */
export interface Binding {
  id: string;
  focus: number;
  gap: number;
  /** Normalized point on the target, for arrows pinned to an exact spot. */
  fixed: [number, number] | null;
}

export interface Terminal {
  x: number;
  y: number;
  bind: Binding | null;
}

export interface ArrowElement extends Base {
  type: "arrow";
  start: Terminal;
  end: Terminal;
  /** Bend points between start and end, "x,y x,y". */
  via: string;
  route: "straight" | "elbow";
  /** A plain line rather than an arrow. */
  line: boolean;
  heads: { start: string; end: string }; // "none", "arrow", "triangle", "dot", "bar", ...
  text: string;
}

/** A card that links to another item in the workspace. */
export interface CardElement extends Base {
  type: "card";
  w: number;
  h: number;
  ref: string;
}

export type Element = BoxElement | TextElement | FreehandElement | ArrowElement | CardElement;

export const DEFAULT_STYLE: Style = {
  color: "#1e1e1e",
  background: "transparent",
  fill: "solid",
  stroke: "solid",
  width: 2,
  sketch: 1,
  opacity: 100,
  rounded: true,
  font: "hand",
  fontSize: 20,
  align: "center",
};

// ---- point encoding -----------------------------------------------------------

export function encodePoints(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${round(x)},${round(y)}`).join(" ");
}

export function decodePoints(s: string | undefined): [number, number][] {
  if (!s) return [];
  return s.split(" ").map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return [x, y];
  });
}

const round = (n: number) => Math.round(n * 10) / 10;

// ---- migration ----------------------------------------------------------------
// Boards saved by the first (tldraw) build used named colors and size presets.
// Read them forward so nothing drawn earlier is lost.

const NAMED: Record<string, string> = {
  black: "#1e1e1e", grey: "#868e96", violet: "#6741d9", "light-violet": "#9775fa",
  blue: "#1971c2", "light-blue": "#4dabf7", yellow: "#f08c00", orange: "#e8590c",
  green: "#2f9e44", "light-green": "#40c057", red: "#e03131", "light-red": "#ff8787",
  white: "#ffffff",
};
const SIZE_WIDTH: Record<string, number> = { s: 1, m: 2, l: 3, xl: 4 };
const SIZE_FONT: Record<string, number> = { s: 16, m: 20, l: 28, xl: 36 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

export function migrateStyle(raw: Loose | undefined): Style {
  const s = raw ?? {};
  if (typeof s.width === "number") return { ...DEFAULT_STYLE, ...s } as Style;
  const color = NAMED[s.color] ?? DEFAULT_STYLE.color;
  const background =
    s.fill === "solid" || s.fill === "pattern" ? color : s.fill === "semi" ? `${color}33` : "transparent";
  return {
    ...DEFAULT_STYLE,
    color,
    background,
    fill: s.fill === "pattern" ? "hatch" : "solid",
    stroke: s.stroke === "dashed" || s.stroke === "dotted" ? s.stroke : "solid",
    sketch: s.stroke === "sketch" ? 2 : 1,
    width: SIZE_WIDTH[s.size] ?? 2,
    fontSize: SIZE_FONT[s.size] ?? 20,
    font: s.font === "serif" || s.font === "mono" || s.font === "sans" ? s.font : "hand",
    align: s.align === "start" ? "left" : s.align === "end" ? "right" : "center",
  };
}

export function migrateElement(raw: Loose): Element {
  const base = {
    x: raw.x ?? 0,
    y: raw.y ?? 0,
    rotation: raw.rotation ?? 0,
    z: raw.z ?? "a0",
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    style: migrateStyle(raw.style),
  };
  if (raw.type === "arrow") {
    const term = (t: Loose | undefined): Terminal => ({
      x: t?.x ?? 0,
      y: t?.y ?? 0,
      bind: t?.bind
        ? { id: t.bind.id, focus: t.bind.focus ?? 0, gap: t.bind.gap ?? 4, fixed: t.bind.fixed ?? null }
        : null,
    });
    return {
      ...base,
      type: "arrow",
      start: term(raw.start),
      end: term(raw.end),
      via: raw.via ?? "",
      route: raw.route === "elbow" ? "elbow" : "straight",
      line: !!raw.line,
      heads: { start: raw.heads?.start ?? "none", end: raw.heads?.end ?? "arrow" },
      text: raw.text ?? "",
    };
  }
  if (raw.type === "freehand") return { ...base, type: "freehand", strokes: raw.strokes ?? [] };
  return { ...raw, ...base } as Element;
}
