// Themes: a color scheme (light or dark, which every style keys off) plus a
// palette that retints the surfaces. "System" follows the OS between the two
// default palettes. The preview colors here draw the cards in Settings.

export type Scheme = "light" | "dark";

export interface ThemeDef {
  id: string;
  label: string;
  /** Null: follows the system. */
  scheme: Scheme | null;
  /** data-palette on <html>; "default" is styles.css's base light or dark. */
  palette: string;
  hint: string;
  /** canvas, rail, ink: for the preview card. System shows light. */
  preview: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: "system", label: "System", scheme: null, palette: "default", hint: "Follows your computer", preview: ["#fcfcfd", "#f5f6f8", "#1b2230"] },
  { id: "light", label: "Light", scheme: "light", palette: "default", hint: "Cool white", preview: ["#fcfcfd", "#f5f6f8", "#1b2230"] },
  { id: "paper", label: "Paper", scheme: "light", palette: "paper", hint: "Warm cream", preview: ["#f8f4ec", "#efe9dd", "#2b2416"] },
  { id: "rose", label: "Rose", scheme: "light", palette: "rose", hint: "Soft pink-grey", preview: ["#fcf7f8", "#f5ecef", "#2a1f24"] },
  { id: "solarized-light", label: "Solarized Light", scheme: "light", palette: "solarized-light", hint: "Ethan Schoonover's palette", preview: ["#fdf6e3", "#eee8d5", "#073642"] },
  { id: "dark", label: "Dark", scheme: "dark", palette: "default", hint: "Cool charcoal", preview: ["#15181e", "#1b1f27", "#e3e6eb"] },
  { id: "dusk", label: "Dusk", scheme: "dark", palette: "dusk", hint: "Dim, lower contrast", preview: ["#1c1f26", "#22262e", "#d8dce3"] },
  { id: "nord", label: "Nord", scheme: "dark", palette: "nord", hint: "Arctic blue-grey", preview: ["#2e3440", "#3b4252", "#eceff4"] },
  { id: "forest", label: "Forest", scheme: "dark", palette: "forest", hint: "Deep green", preview: ["#15201b", "#1a2821", "#e3ebe6"] },
  { id: "solarized-dark", label: "Solarized Dark", scheme: "dark", palette: "solarized-dark", hint: "Teal-black", preview: ["#002b36", "#073642", "#eee8d5"] },
  { id: "midnight", label: "Midnight", scheme: "dark", palette: "midnight", hint: "True black, for OLED", preview: ["#000000", "#0b0b0d", "#e6e6e6"] },
];

export const THEME_IDS = THEMES.map((t) => t.id);

export function themeDef(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
