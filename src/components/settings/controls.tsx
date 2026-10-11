import type { ReactNode } from "react";

/** A row of mutually exclusive buttons, as an ARIA radio group. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const i = options.findIndex((o) => o.value === value);
  const move = (d: number) => onChange(options[(i + d + options.length) % options.length].value);
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
        else return;
        e.preventDefault();
        // Keep focus on the newly chosen option.
        requestAnimationFrame(() =>
          (e.currentTarget.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus(),
        );
      }}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value || (i < 0 && o === options[0]) ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled setting: name and description on the left, control on the right. */
export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="pref">
      <div className="pref-text">
        <span className="pref-label" id={id}>
          {label}
        </span>
        {hint && <span className="pref-hint">{hint}</span>}
      </div>
      <div className="pref-control">{children}</div>
    </div>
  );
}

/** An on/off switch. */
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}
