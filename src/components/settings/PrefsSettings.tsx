import { ACCENTS, DEFAULTS, MARGIN_MAX, MARGIN_MIN, ZOOMS, resetPrefs, setPrefs, usePrefs, type Accent, type Prefs } from "../../lib/prefs";
import { Field, Segmented, Toggle } from "./controls";
import { THEMES } from "../../lib/themes";
import { openWithApp, setOpenWithApp } from "../../lib/git";
import { useState } from "react";

const mac = navigator.platform.includes("Mac");
const mod = mac ? "⌘" : "Ctrl";

/** A key combination: Ctrl + = shows as two keys. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

const ACCENT_SWATCH: Record<Accent, string> = {
  indigo: "#3346c9",
  blue: "#1f63c6",
  teal: "#0b7285",
  green: "#2b7a3d",
  orange: "#d4520d",
  pink: "#c2255c",
  violet: "#6741d9",
};

const pct = (z: number) => `${Math.round(z * 100)}%`;

function TextSize({ p }: { p: Prefs }) {
  return (
    <Field label="Text size" hint={`Scales the whole app. Anywhere, hold ${mod} and press + or − to change it, or 0 to reset.`}>
      <select
        className="field"
        aria-label="Text size"
        value={p.zoom}
        onChange={(e) => setPrefs({ zoom: Number(e.target.value) })}
      >
        {ZOOMS.map((z) => (
          <option key={z} value={z}>
            {pct(z)}
            {z === 1 ? " (default)" : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

const APPEARANCE: (keyof Prefs)[] = ["theme", "accent", "zoom", "density", "readingFont", "width", "margin", "align"];
const ACCESS: (keyof Prefs)[] = ["motion", "contrast", "focus", "underlineLinks", "readableFont"];

function isDefault(p: Prefs, keys: (keyof Prefs)[]) {
  return keys.every((k) => p[k] === DEFAULTS[k]);
}

export function AppearanceSettings() {
  const p = usePrefs();
  return (
    <div className="prefs">
      <section className="card">
        <h2>Theme</h2>
        <Field label="Theme" hint="System follows your computer between Light and Dark.">
          <div className="theme-grid" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={p.theme === t.id}
                className="theme-card"
                title={t.hint}
                onClick={() => setPrefs({ theme: t.id })}
              >
                <span className="theme-swatch" style={{ background: t.preview[0], borderColor: t.preview[1] }} aria-hidden="true">
                  <span style={{ background: t.preview[1] }} />
                  <span className="theme-swatch-ink" style={{ background: t.preview[2] }} />
                </span>
                <span className="theme-card-label">{t.label}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Accent color" hint="Selection, links, and buttons.">
          <div className="swatches" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <button
                key={a}
                className="swatch"
                role="radio"
                aria-checked={p.accent === a}
                aria-label={a[0].toUpperCase() + a.slice(1)}
                title={a[0].toUpperCase() + a.slice(1)}
                style={{ background: ACCENT_SWATCH[a] }}
                onClick={() => setPrefs({ accent: a })}
              />
            ))}
          </div>
        </Field>
      </section>

      <section className="card">
        <h2>Layout and type</h2>
        <TextSize p={p} />
        <Field label="Sidebar density" hint="Compact fits more pages on screen.">
          <Segmented
            label="Sidebar density"
            value={p.density}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
            onChange={(density) => setPrefs({ density })}
          />
        </Field>
        <Field label="Note font" hint="For reading and writing notes.">
          <Segmented
            label="Note font"
            value={p.readingFont}
            options={[
              { value: "serif", label: "Serif" },
              { value: "sans", label: "Sans serif" },
            ]}
            onChange={(readingFont) => setPrefs({ readingFont })}
          />
        </Field>
        <Field label="Note width" hint="How wide a line of text can get. Full uses the whole window.">
          <Segmented
            label="Note width"
            value={p.width}
            options={[
              { value: "narrow", label: "Narrow" },
              { value: "normal", label: "Normal" },
              { value: "wide", label: "Wide" },
              { value: "full", label: "Full" },
            ]}
            onChange={(width) => setPrefs({ width })}
          />
        </Field>
        <Field
          label="Alignment"
          hint={
            p.width === "full"
              ? "Centered keeps the margin on both sides. Left keeps it on the left only, and the text runs to the right edge."
              : "Where the note sits when the window is wider than it."
          }
        >
            <Segmented
              label="Note alignment"
              value={p.align}
              options={[
                { value: "center", label: "Centered" },
                { value: "left", label: "Left" },
              ]}
              onChange={(align) => setPrefs({ align })}
            />
          </Field>
        {p.width === "full" && (
          <Field label="Margins" hint={p.align === "left" ? "Space on the left of a full-width note." : "Space on each side of a full-width note."}>
            <span className="range-field">
              <input
                type="range"
                aria-label="Note margins"
                min={MARGIN_MIN}
                max={MARGIN_MAX}
                step={0.5}
                value={p.margin}
                onChange={(e) => setPrefs({ margin: Number(e.target.value) })}
              />
              <span className="range-value">{p.margin}rem</span>
            </span>
          </Field>
        )}
      </section>

      <section className="card">
        <h2>Linked folders</h2>
        <Field label="Open with" hint={`A folder linked from a task or project opens in this app. Empty: the ${mac ? "Finder" : "file manager"}. Try "Visual Studio Code", "Terminal", "Cursor".`}>
          <OpenWith />
        </Field>
      </section>

      <p className="prefs-foot">
        <span className="muted small">These settings are for this device only.</span>
        <button className="ghost" disabled={isDefault(p, APPEARANCE)} onClick={() => resetPrefs(APPEARANCE)}>
          Reset appearance
        </button>
      </p>
    </div>
  );
}

export function AccessibilitySettings() {
  const p = usePrefs();
  return (
    <div className="prefs">
      <section className="card">
        <h2>Seeing</h2>
        <TextSize p={p} />
        <Field label="Contrast" hint="Darker secondary text and stronger borders.">
          <Segmented
            label="Contrast"
            value={p.contrast}
            options={[
              { value: "normal", label: "Standard" },
              { value: "more", label: "More" },
            ]}
            onChange={(contrast) => setPrefs({ contrast })}
          />
        </Field>
        <Field label="Readable font" hint="Atkinson Hyperlegible everywhere: letters designed to be hard to confuse.">
          <Toggle label="Readable font" checked={p.readableFont} onChange={(readableFont) => setPrefs({ readableFont })} />
        </Field>
        <Field label="Underline links" hint="So links don't rely on color alone.">
          <Toggle label="Underline links" checked={p.underlineLinks} onChange={(underlineLinks) => setPrefs({ underlineLinks })} />
        </Field>
      </section>

      <section className="card">
        <h2>Moving around</h2>
        <Field label="Focus indicator" hint="A thicker, haloed outline on whatever has keyboard focus.">
          <Segmented
            label="Focus indicator"
            value={p.focus}
            options={[
              { value: "normal", label: "Standard" },
              { value: "strong", label: "Strong" },
            ]}
            onChange={(focus) => setPrefs({ focus })}
          />
        </Field>
        <Field label="Motion" hint="Turns off animations and smooth scrolling.">
          <Segmented
            label="Motion"
            value={p.motion}
            options={[
              { value: "system", label: "Follow system" },
              { value: "reduce", label: "Reduce" },
            ]}
            onChange={(motion) => setPrefs({ motion })}
          />
        </Field>
        <div className="shortcuts">
          <h3>Keyboard shortcuts</h3>
          <dl>
            <dt><Keys keys={[mod, "K"]} /></dt>
            <dd>Search pages and tasks, or run a command</dd>
            <dt><Keys keys={[mod, ","]} /></dt>
            <dd>Open settings</dd>
            <dt><Keys keys={[mod, "\\"]} /></dt>
            <dd>Show or hide the sidebar</dd>
            <dt><Keys keys={[mod, "+"]} /> <Keys keys={[mod, "−"]} /> <Keys keys={[mod, "0"]} /></dt>
            <dd>Text size bigger, smaller, default</dd>
            <dt><Keys keys={["/"]} /></dt>
            <dd>Insert a block in a note; select text for the formatting bar</dd>
            <dt><Keys keys={["Tab"]} /> <Keys keys={["Shift", "Tab"]} /></dt>
            <dd>Move between controls; arrow keys move within a group</dd>
          </dl>
        </div>
      </section>

      <p className="prefs-foot">
        <span className="muted small">These settings are for this device only.</span>
        <button className="ghost" disabled={isDefault(p, ACCESS)} onClick={() => resetPrefs(ACCESS)}>
          Reset accessibility
        </button>
      </p>
    </div>
  );
}

function OpenWith() {
  const [app, setApp] = useState(openWithApp);
  return (
    <input
      className="field"
      value={app}
      placeholder={mac ? "Finder" : "File manager"}
      aria-label="App that opens linked folders"
      onChange={(e) => setApp(e.target.value)}
      onBlur={() => setOpenWithApp(app)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}
