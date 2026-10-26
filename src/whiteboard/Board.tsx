import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme } from "../lib/prefs";
import { CaptureUpdateAction, Excalidraw, newElementWith, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { A } from "../lib/automerge";
import { useItemLookup } from "../lib/useItemLookup";
import { registerFlush } from "../lib/pending";
import { openExternal } from "../lib/openLink";
import { PinButton } from "../components/PinnedNav";
import { PopOutButton } from "../components/PopOutButton";
import { isPinned, usePins } from "../lib/pins";
import type { WorkspaceSession } from "../lib/session";
import { SUPPORTED, fromExcalidraw, toExcalidraw } from "./adapter";
import { migrateElement, type Element } from "./schema";
import { useCanEdit } from "../lib/access";

type Doc = { elements?: Record<string, unknown> };

/** Copy out of Automerge proxies into plain JSON, turning ImmutableStrings into strings. */
function plain<T>(value: unknown): T {
  return JSON.parse(
    JSON.stringify(value ?? null, (_k, v) => (A.isImmutableString(v) ? v.toString() : v)),
  ) as T;
}

/** Point lists are long and only ever replaced whole, so store them as scalars. */
function toStored(el: Element): unknown {
  if (el.type === "freehand") {
    return { ...el, strokes: el.strokes.map((s) => ({ ...s, points: new A.ImmutableString(s.points) })) };
  }
  if (el.type === "arrow") return { ...el, via: new A.ImmutableString(el.via) };
  return el;
}

function applyElements(d: Doc, puts: [string, Element][], dels: string[]) {
  if (!d.elements) d.elements = {};
  const els = d.elements as Record<string, Record<string, unknown>>;
  for (const [id, el] of puts) {
    const cur = els[id];
    const next = toStored(el) as Record<string, unknown>;
    if (!cur) {
      els[id] = next;
      continue;
    }
    // Only write fields that changed, so history stays small and merges stay granular.
    for (const key of Object.keys(next)) {
      if (JSON.stringify(plain(cur[key])) !== JSON.stringify(plain(next[key]))) cur[key] = next[key];
    }
  }
  for (const id of dels) delete els[id];
}

function usePrefersDark() {
  return useTheme() === "dark";
}

interface Props {
  session: WorkspaceSession;
  id: string;
  initial: Record<string, unknown> | undefined;
  /** The title block; gets what sits beside the title (pin, pop out). */
  header: (aside: ReactNode) => ReactNode;
  onOpen: (id: string) => void;
  onError: (err: unknown) => void;
}

export function Board({ session, id, initial, header, onOpen, onError }: Props) {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const dark = usePrefersDark();
  const canEdit = useCanEdit();
  const canvasRef = useRef<HTMLDivElement>(null);

  const lookup = useItemLookup(session, onError);
  const pins = usePins(session.id);

  const titleOf = useCallback(
    (ref: string) => {
      const item = lookup?.get(ref);
      return item ? item.title || "Untitled" : "Deleted item";
    },
    [lookup],
  );

  // Build the scene once, after titles are known.
  const scene = useMemo(() => {
    if (!lookup) return null;
    const raw = plain<Record<string, Record<string, unknown>>>(initial ?? {});
    const elements: Record<string, Element> = {};
    for (const [eid, el] of Object.entries(raw)) elements[eid] = migrateElement(el);
    return toExcalidraw(elements, titleOf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup === null]);

  // ---- saving -----------------------------------------------------------------

  const versions = useRef(new Map<string, number>());
  const dirty = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    scene?.forEach((el) => versions.current.set(el.id, el.version));
  }, [scene]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!excalidraw || (!dirty.current.size && !removed.current.size)) return;
    const all = excalidraw.getSceneElementsIncludingDeleted();
    const byId = new Map(all.map((e) => [e.id, e]));
    const puts: [string, Element][] = [];
    const dels = new Set(removed.current);
    for (const eid of dirty.current) {
      const ex = byId.get(eid);
      if (!ex || ex.isDeleted) {
        dels.add(eid);
        continue;
      }
      const el = fromExcalidraw(ex, byId);
      if (el) puts.push([eid, el]);
    }
    dirty.current.clear();
    removed.current.clear();
    if (!puts.length && !dels.size) return;
    sessionRef.current
      .changeItem<Doc & { title: string; tags: string[] }>(id, "edit", (d) => applyElements(d, puts, [...dels]))
      .catch(onError);
  }, [excalidraw, id, onError]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const unregister = registerFlush(() => flushRef.current());
    return () => {
      unregister();
      flushRef.current(); // don't lose the last edits when leaving
    };
  }, []);

  const onChange = (elements: readonly ExcalidrawElement[]) => {
    if (!canEdit) return;
    const unsupported: string[] = [];
    let changed = false;
    for (const el of elements) {
      if (versions.current.get(el.id) === el.version) continue;
      versions.current.set(el.id, el.version);
      changed = true;
      if (!SUPPORTED.has(el.type)) {
        if (!el.isDeleted) unsupported.push(el.id);
        continue;
      }
      // A container's label is stored with the container.
      const target = el.type === "text" && el.containerId ? el.containerId : el.id;
      if (el.isDeleted && target === el.id) {
        removed.current.add(el.id);
        dirty.current.delete(el.id);
      } else {
        dirty.current.add(target);
      }
    }
    // Images, frames, and embeds have no place in the schema.
    if (unsupported.length && excalidraw) {
      const drop = new Set(unsupported);
      excalidraw.updateScene({
        elements: elements.map((e) => (drop.has(e.id) ? newElementWith(e, { isDeleted: true }) : e)),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    if (changed) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flushRef.current(), 400);
    }
  };

  // Text is measured when the scene is built, which is usually before the
  // handwriting fonts have arrived: Excalidraw fetches them on demand, per
  // character range, once it mounts. When they land it repaints but keeps the
  // widths measured with the fallback font, so text runs past its box and is
  // clipped until something re-measures it (editing it does). Re-measure
  // every text element whenever fonts finish loading.
  useEffect(() => {
    if (!excalidraw) return;
    let live = true;
    const remeasure = () => {
      if (!live) return;
      const all = excalidraw.getSceneElementsIncludingDeleted();
      if (!all.some((e) => e.type === "text" && !e.isDeleted)) return;
      excalidraw.updateScene({
        // Versions are kept, so nothing is saved until the element is next edited.
        elements: restoreElements(all, null, { refreshDimensions: true, repairBindings: true }),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    document.fonts.addEventListener("loadingdone", remeasure);
    // Fonts that loaded between building the scene and mounting.
    document.fonts.ready.then(remeasure, () => {});
    return () => {
      live = false;
      document.fonts.removeEventListener("loadingdone", remeasure);
    };
  }, [excalidraw]);

  // Keep card labels in step with the items they link to.
  useEffect(() => {
    if (!excalidraw || !lookup) return;
    const all = excalidraw.getSceneElementsIncludingDeleted();
    const byId = new Map(all.map((e) => [e.id, e]));
    const updates = new Map<string, ExcalidrawElement>();
    for (const el of all) {
      const ref = (el.customData as { ref?: string } | undefined)?.ref;
      if (!ref || el.isDeleted) continue;
      const labelRef = el.boundElements?.find((b) => b.type === "text");
      const label = labelRef && byId.get(labelRef.id);
      const title = titleOf(ref);
      if (label && label.type === "text" && label.originalText !== title) {
        updates.set(label.id, newElementWith(label, { text: title, originalText: title }));
      }
    }
    if (updates.size) {
      excalidraw.updateScene({
        elements: all.map((e) => updates.get(e.id) ?? e),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, [excalidraw, lookup, titleOf]);

  return (
    <>
      <div className="board-head">
        <div className="board-head-main">
          {header(
            <>
              <PinButton workspace={session.id} pin={{ kind: "node", id }} pinned={isPinned(pins, { kind: "node", id })} />
              <PopOutButton session={session} id={id} />
            </>,
          )}
        </div>
      </div>
      <div className="board-canvas" ref={canvasRef}>
        {scene && (
          <Excalidraw
            initialData={{ elements: scene, scrollToContent: true }}
            excalidrawAPI={setExcalidraw}
            onChange={onChange}
            onLinkOpen={(element, event) => {
              // Never let a link navigate the app window: cards open the linked
              // item, web links open in the system browser.
              event.preventDefault();
              const ref = (element.customData as { ref?: string } | undefined)?.ref;
              if (ref) onOpen(ref);
              else openExternal(element.link, onError);
            }}
            theme={dark ? "dark" : "light"}
            viewModeEnabled={!canEdit}
            // Shortcuts work without first clicking into the canvas; Excalidraw
            // ignores keys typed into inputs, so the title field is unaffected.
            handleKeyboardGlobally
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                toggleTheme: null,
                changeViewBackgroundColor: false,
              },
              tools: { image: false },
            }}
          />
        )}
      </div>
    </>
  );
}
