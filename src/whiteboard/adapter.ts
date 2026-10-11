// The only file that knows both the storage schema and Excalidraw. Swapping
// canvas libraries means replacing this file and Board.tsx, nothing else.
import {
  FONT_FAMILY,
  ROUNDNESS,
  convertToExcalidrawElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";
import {
  DEFAULT_STYLE,
  decodePoints,
  encodePoints,
  type Binding,
  type Element,
  type Font,
  type Style,
} from "./schema";

/** Element types the schema can store. Anything else is removed from the canvas. */
export const SUPPORTED = new Set(["rectangle", "ellipse", "diamond", "text", "freedraw", "arrow", "line"]);

const FONT_TO_EX: Record<Font, number> = {
  hand: FONT_FAMILY.Excalifont,
  sans: FONT_FAMILY.Nunito,
  serif: FONT_FAMILY["Liberation Sans"],
  mono: FONT_FAMILY["Comic Shanns"],
};

function fontFrom(family: number | undefined): Font {
  switch (family) {
    case FONT_FAMILY.Excalifont:
    case FONT_FAMILY.Virgil:
      return "hand";
    case FONT_FAMILY["Comic Shanns"]:
    case FONT_FAMILY.Cascadia:
      return "mono";
    case FONT_FAMILY["Liberation Sans"]:
      return "serif";
    default:
      return "sans";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ex = any; // Excalidraw elements are deeply readonly; the adapter builds plain objects.

/** The card's link, so Excalidraw shows a link affordance and calls onLinkOpen. */
export const cardLink = (ref: string) => `#item/${ref}`;

// ---- Excalidraw -> schema --------------------------------------------------------

function styleFrom(el: ExcalidrawElement, label?: ExcalidrawTextElement | null): Style {
  const t = (label ?? (el.type === "text" ? el : null)) as ExcalidrawTextElement | null;
  return {
    color: el.strokeColor,
    background: el.backgroundColor,
    fill: el.fillStyle === "hachure" ? "hatch" : el.fillStyle === "cross-hatch" || el.fillStyle === "zigzag" ? el.fillStyle : "solid",
    stroke: el.strokeStyle,
    width: el.strokeWidth,
    sketch: el.roughness,
    opacity: el.opacity,
    rounded: !!el.roundness,
    font: t ? fontFrom(t.fontFamily) : DEFAULT_STYLE.font,
    fontSize: t?.fontSize ?? DEFAULT_STYLE.fontSize,
    align: (t?.textAlign as Style["align"]) ?? DEFAULT_STYLE.align,
  };
}

function bindingFrom(b: Ex): Binding | null {
  if (!b) return null;
  return { id: b.elementId, focus: b.focus ?? 0, gap: b.gap ?? 4, fixed: b.fixedPoint ?? null };
}

/**
 * Convert a live Excalidraw element to a storage element. Returns null for
 * elements stored as part of another (container labels) or not storable.
 */
export function fromExcalidraw(el: ExcalidrawElement, byId: Map<string, ExcalidrawElement>): Element | null {
  const labelOf = (): ExcalidrawTextElement | null => {
    const ref = el.boundElements?.find((b) => b.type === "text");
    const t = ref ? byId.get(ref.id) : null;
    return t && !t.isDeleted && t.type === "text" ? t : null;
  };
  const base = {
    x: el.x,
    y: el.y,
    rotation: el.angle,
    z: el.index ?? "a0",
    groups: [...el.groupIds],
  };

  switch (el.type) {
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const label = labelOf();
      const ref = (el.customData as { ref?: string } | undefined)?.ref;
      if (ref) return { ...base, style: styleFrom(el, label), type: "card", w: el.width, h: el.height, ref };
      return {
        ...base,
        style: styleFrom(el, label),
        type: el.type === "rectangle" ? "rect" : el.type,
        w: el.width,
        h: el.height,
        text: label?.originalText ?? "",
      };
    }
    case "text":
      if (el.containerId) return null; // saved with its container
      return {
        ...base,
        style: styleFrom(el),
        type: "text",
        w: el.width,
        autoSize: el.autoResize,
        text: el.originalText,
      };
    case "freedraw":
      return {
        ...base,
        style: styleFrom(el),
        type: "freehand",
        strokes: [{ straight: false, points: encodePoints(el.points) }],
      };
    case "arrow":
    case "line": {
      const pts = el.points;
      const first = pts[0] ?? [0, 0];
      const last = pts[pts.length - 1] ?? [0, 0];
      const label = labelOf();
      return {
        ...base,
        style: styleFrom(el, label),
        type: "arrow",
        start: { x: first[0], y: first[1], bind: bindingFrom(el.startBinding) },
        end: { x: last[0], y: last[1], bind: bindingFrom(el.endBinding) },
        via: encodePoints(pts.slice(1, -1)),
        route: el.type === "arrow" && (el as Ex).elbowed ? "elbow" : "straight",
        line: el.type === "line",
        heads: { start: el.startArrowhead ?? "none", end: el.endArrowhead ?? "none" },
        text: label?.originalText ?? "",
      };
    }
    default:
      return null;
  }
}

// ---- schema -> Excalidraw --------------------------------------------------------

function common(id: string, el: Element) {
  const s = el.style;
  return {
    id,
    x: el.x,
    y: el.y,
    angle: el.rotation,
    strokeColor: s.color,
    backgroundColor: s.background,
    fillStyle: s.fill === "hatch" ? "hachure" : s.fill,
    strokeWidth: s.width,
    strokeStyle: s.stroke,
    roughness: s.sketch,
    opacity: s.opacity,
    groupIds: el.groups,
  };
}

function label(text: string, s: Style) {
  return text
    ? {
        text,
        fontFamily: FONT_TO_EX[s.font],
        fontSize: s.fontSize,
        textAlign: s.align,
        verticalAlign: "middle",
        strokeColor: s.color,
      }
    : undefined;
}

type Lookup = (ref: string) => string;

function toSkeleton(id: string, el: Element, titleOf: Lookup): Ex {
  const s = el.style;
  switch (el.type) {
    case "rect":
    case "ellipse":
    case "diamond":
      return {
        ...common(id, el),
        type: el.type === "rect" ? "rectangle" : el.type,
        width: el.w,
        height: el.h,
        roundness: s.rounded
          ? { type: el.type === "rect" ? ROUNDNESS.ADAPTIVE_RADIUS : ROUNDNESS.PROPORTIONAL_RADIUS }
          : null,
        label: label(el.text, s),
      };
    case "card":
      return {
        ...common(id, el),
        type: "rectangle",
        width: el.w,
        height: el.h,
        roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
        link: cardLink(el.ref),
        customData: { ref: el.ref },
        label: label(titleOf(el.ref), { ...s, align: "center" }),
      };
    case "text":
      return {
        ...common(id, el),
        type: "text",
        text: el.text,
        fontFamily: FONT_TO_EX[s.font],
        fontSize: s.fontSize,
        textAlign: s.align,
        autoResize: el.autoSize,
        ...(el.autoSize ? {} : { width: el.w }),
      };
    case "freehand":
      return {
        ...common(id, el),
        type: "freedraw",
        points: el.strokes.flatMap((st) => decodePoints(st.points)),
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
      };
    case "arrow":
      return {
        ...common(id, el),
        type: el.line ? "line" : "arrow",
        points: [[el.start.x, el.start.y], ...decodePoints(el.via), [el.end.x, el.end.y]],
        startArrowhead: el.heads.start === "none" ? null : el.heads.start,
        endArrowhead: el.heads.end === "none" ? null : el.heads.end,
        roundness: s.rounded ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
        ...(el.line ? {} : { elbowed: el.route === "elbow" }),
        label: label(el.text, s),
      };
  }
}

function bindingTo(b: Binding | null, ids: Set<string>) {
  if (!b || !ids.has(b.id)) return null;
  return { elementId: b.id, focus: b.focus, gap: b.gap, ...(b.fixed ? { fixedPoint: b.fixed } : {}) };
}

/** Build the full Excalidraw scene for stored elements, in z order. */
export function toExcalidraw(elements: Record<string, Element>, titleOf: Lookup): ExcalidrawElement[] {
  const entries = Object.entries(elements).sort(([, a], [, b]) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0));
  const ids = new Set(entries.map(([id]) => id));
  const skeletons: Ex[] = [];
  for (const [id, el] of entries) {
    try {
      skeletons.push(toSkeleton(id, el, titleOf));
    } catch (err) {
      console.warn("Skipping unreadable element", id, err);
    }
  }
  const scene: Ex[] = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  // Restore the exact stored bindings rather than letting the skeleton API guess.
  for (const ex of scene) {
    const el = elements[ex.id];
    if (el?.type === "arrow") {
      ex.startBinding = bindingTo(el.start.bind, ids);
      ex.endBinding = bindingTo(el.end.bind, ids);
    }
  }
  return restoreElements(scene, null, { repairBindings: true });
}
