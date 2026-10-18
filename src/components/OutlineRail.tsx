// The outline beside a note: its headings, the one you're reading marked,
// click to jump. Shows once a note has a couple of headings and the window
// is wide enough to spare the room.
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Icon } from "./Icon";

const COLLAPSED_KEY = "outline:collapsed";

interface Heading {
  id: string;
  level: number;
  text: string;
  /** Position of the heading node in the document. */
  pos: number;
}

/** Fewer headings than this and the rail stays hidden. */
const MIN_HEADINGS = 1;
/** Below this window width the rail folds to its strip on its own. */
const NARROW = "(max-width: 1100px)";
/** The heading at or above this many pixels below the top of the scroll box is the current one. */
const READ_LINE = 96;

export function OutlineRail({ editor }: { editor: Editor | null }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const ref = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // storage unavailable: the choice just won't stick
    }
  };

  // Headings follow the document.
  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      return;
    }
    let frame = 0;
    const read = () => {
      const out: Heading[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading") {
          const text = node.textContent.trim();
          out.push({ id: `${pos}-${text}`, level: Number(node.attrs.level) || 1, text: text || "Untitled heading", pos });
        }
        // Headings are never nested in anything we need to descend into.
        return node.type.name !== "heading";
      });
      setHeadings((prev) => (sameList(prev, out) ? prev : out));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    read();
    editor.on("update", schedule);
    return () => {
      editor.off("update", schedule);
      cancelAnimationFrame(frame);
    };
  }, [editor]);

  // The current heading follows the scroll position.
  useEffect(() => {
    if (!editor || headings.length < MIN_HEADINGS) return;
    const scroller = scrollParent(editor.view.dom);
    const elementFor = (h: Heading): HTMLElement | null => {
      const el = editor.view.nodeDOM(h.pos);
      return el instanceof HTMLElement ? el : null;
    };
    let frame = 0;
    const update = () => {
      // Scrolled to the end: the last heading is the one being read, whatever its position.
      const atEnd =
        scroller === window
          ? window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
          : (scroller as HTMLElement).scrollTop + (scroller as HTMLElement).clientHeight >= (scroller as HTMLElement).scrollHeight - 2;
      if (atEnd) {
        setCurrent(headings[headings.length - 1].id);
        return;
      }
      const top = scroller === window ? 0 : (scroller as HTMLElement).getBoundingClientRect().top;
      let found: Heading | null = null;
      for (const h of headings) {
        const el = elementFor(h);
        if (!el) continue;
        if (el.getBoundingClientRect().top - top <= READ_LINE) found = h;
        else break;
      }
      setCurrent((found ?? headings[0]).id);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    const target = scroller === window ? window : (scroller as HTMLElement);
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [editor, headings]);

  // Keep the current entry in view inside a long rail. Only the rail scrolls:
  // scrollIntoView would also move the page and cancel a jump in progress.
  useEffect(() => {
    const rail = ref.current;
    const el = rail?.querySelector<HTMLElement>("[aria-current]");
    if (!rail || !el) return;
    const top = el.offsetTop - rail.offsetTop;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (top + el.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = top + el.offsetHeight - rail.clientHeight;
  }, [current]);

  if (!editor || headings.length < MIN_HEADINGS) return null;
  const minLevel = Math.min(...headings.map((h) => h.level));

  const jump = (h: Heading) => {
    const el = editor.view.nodeDOM(h.pos);
    if (!(el instanceof HTMLElement)) return;
    const scroller = scrollParent(el);
    if (scroller === window) el.scrollIntoView({ block: "start", behavior: "smooth" });
    else {
      const box = scroller as HTMLElement;
      const y = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 72;
      box.scrollTo({ top: y, behavior: "smooth" });
    }
    setCurrent(h.id);
  };

  if (collapsed || narrow) {
    // A slim strip: one tick per heading, the current one marked. Click to open.
    // A narrow window folds it whatever the setting; the list needs the room.
    return (
      <nav className="outline outline-collapsed" aria-label="On this page" ref={ref}>
        <button
          className="outline-toggle"
          title={narrow ? "Widen the window to show the outline" : "Show the outline"}
          aria-label="Show the outline"
          aria-expanded={false}
          disabled={narrow}
          onClick={toggle}
        >
          <Icon name="chevron" className="outline-chev" />
        </button>
        <ol className="outline-ticks" aria-hidden="true">
          {headings.map((h) => (
            <li key={h.id} data-current={current === h.id || undefined} style={{ ["--depth" as string]: h.level - minLevel }} onClick={() => jump(h)} />
          ))}
        </ol>
      </nav>
    );
  }

  return (
    <nav className="outline" aria-label="On this page" ref={ref}>
      <p className="outline-title">
        <button className="outline-toggle" title="Hide the outline" aria-label="Hide the outline" aria-expanded={true} onClick={toggle}>
          <Icon name="chevron" className="outline-chev" />
        </button>
        On this page
      </p>
      <ol className="outline-list">
        {headings.map((h) => (
          <li key={h.id} style={{ ["--depth" as string]: h.level - minLevel }}>
            <button className="outline-item" aria-current={current === h.id ? "location" : undefined} title={h.text} onClick={() => jump(h)}>
              {h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function sameList(a: Heading[], b: Heading[]) {
  return a.length === b.length && a.every((h, i) => h.id === b[i].id && h.level === b[i].level);
}

/**
 * The nearest ancestor that can scroll vertically, or the window. Whether it
 * currently overflows doesn't matter: a note that is short when opened grows
 * as it's written, and the same box scrolls then.
 */
function scrollParent(el: HTMLElement): HTMLElement | Window {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return window;
}
