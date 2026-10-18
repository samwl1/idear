// Appearance and accessibility settings. They belong to this device (each
// screen is different), so they live in localStorage, and apply as data
// attributes on <html> that styles.css keys off.
import { useSyncExternalStore } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { THEME_IDS, themeDef } from "./themes";

/** A theme id from lib/themes.ts: "system", "light", "dark", or a named palette. */
export type Theme = string;
export const ACCENTS = ["indigo", "blue", "teal", "green", "orange", "pink", "violet"] as const;
export type Accent = (typeof ACCENTS)[number];

export interface Prefs {
  theme: Theme;
  accent: Accent;
  /** Page zoom: 1 is 100%. Scales everything, like browser zoom. */
  zoom: number;
  density: "comfortable" | "compact";
  /** Typeface for notes and help. */
  readingFont: "serif" | "sans";
  /** How wide notes run. "full" fills the window, leaving `margin` on each side. */
  width: "narrow" | "normal" | "wide" | "full";
  /** Side margins for full-width notes, in rem. */
  margin: number;
  /**
   * Where a note sits in the window. Capped widths: centered or against the
   * left edge. Full width: "center" keeps `margin` on both sides, "left" only
   * on the left, so the text runs to the window's right edge.
   */
  align: "center" | "left";
  motion: "system" | "reduce";
  contrast: "normal" | "more";
  focus: "normal" | "strong";
  underlineLinks: boolean;
  /** Atkinson Hyperlegible everywhere, designed for low vision. */
  readableFont: boolean;
}

export const ZOOMS = [0.85, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
/** Range of the full-width note margin, in rem. */
export const MARGIN_MIN = 1;
export const MARGIN_MAX = 16;

export const DEFAULTS: Prefs = {
  theme: "system",
  accent: "indigo",
  zoom: 1,
  density: "comfortable",
  readingFont: "serif",
  width: "normal",
  margin: 3.5,
  align: "center",
  motion: "system",
  contrast: "normal",
  focus: "normal",
  underlineLinks: false,
  readableFont: false,
};

const KEY = "prefs";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const p = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
    // Values from storage are untrusted: fall back field by field.
    if (!THEME_IDS.includes(p.theme)) p.theme = DEFAULTS.theme;
    if (!ACCENTS.includes(p.accent)) p.accent = DEFAULTS.accent;
    if (!ZOOMS.includes(p.zoom)) p.zoom = DEFAULTS.zoom;
    if (!["narrow", "normal", "wide", "full"].includes(p.width)) p.width = DEFAULTS.width;
    if (!["center", "left"].includes(p.align)) p.align = DEFAULTS.align;
    if (typeof p.margin !== "number" || !(p.margin >= MARGIN_MIN && p.margin <= MARGIN_MAX)) p.margin = DEFAULTS.margin;
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();
const listeners = new Set<() => void>();

export function resolvedTheme(p: Prefs = prefs): "light" | "dark" {
  return themeDef(p.theme).scheme ?? (darkQuery.matches ? "dark" : "light");
}

let appliedZoom = 1;

function apply() {
  const el = document.documentElement.dataset;
  el.theme = resolvedTheme();
  el.palette = themeDef(prefs.theme).palette;
  el.accent = prefs.accent;
  el.density = prefs.density;
  el.reading = prefs.readingFont;
  el.width = prefs.width;
  el.align = prefs.align;
  document.documentElement.style.setProperty("--note-margin", `${prefs.margin}rem`);
  el.motion = prefs.motion;
  el.contrast = prefs.contrast;
  el.focus = prefs.focus;
  el.links = prefs.underlineLinks ? "underline" : "plain";
  el.font = prefs.readableFont ? "readable" : "default";
  if (prefs.zoom !== appliedZoom) {
    appliedZoom = prefs.zoom;
    getCurrentWebview()
      .setZoom(prefs.zoom)
      .catch((e) => console.error("zoom", e));
  }
}

function emit() {
  apply();
  listeners.forEach((l) => l());
}

darkQuery.addEventListener("change", emit);

/** Apply saved settings before the first render, so nothing flashes. */
export function initPrefs() {
  appliedZoom = 1;
  apply();
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private storage can be unavailable; the setting still applies for now.
  }
  emit();
}

export function resetPrefs(keys: (keyof Prefs)[]) {
  setPrefs(Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]])) as Partial<Prefs>);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => prefs);
}

/** "light" or "dark", following the system when the theme is "system". */
export function useTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () => resolvedTheme());
}

/** Ctrl/Cmd with + - 0: zoom in, out, reset. */
export function zoomStep(dir: 1 | -1 | 0) {
  if (dir === 0) return setPrefs({ zoom: 1 });
  const i = ZOOMS.indexOf(prefs.zoom);
  const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
  setPrefs({ zoom: next });
}
