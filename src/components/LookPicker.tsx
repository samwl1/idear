import { Icon } from "./Icon";
import type { WorkspaceLook } from "../lib/session";
import { LOOK_COLORS, LOOK_ICONS } from "../lib/looks";

/** Color swatches and an icon grid for a workspace's mark. Inline, for a settings card. */
export function LookPicker({ look, onLook }: { look: WorkspaceLook; onLook: (l: WorkspaceLook) => void }) {
  const color = look.color || "indigo";
  return (
    <div className="look-picker">
      <p className="small muted look-label">Color</p>
      <div className="swatches" role="radiogroup" aria-label="Color">
        {LOOK_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={c.value === color}
            aria-label={c.label}
            title={c.label}
            className="swatch"
            style={{ background: `var(--look-${c.value})` }}
            onClick={() => onLook({ color: c.value })}
          />
        ))}
      </div>
      <p className="small muted look-label">Icon</p>
      <div className="icon-grid inline look-icons" role="radiogroup" aria-label="Icon">
        <button type="button" role="radio" aria-checked={!look.icon} title="Initial" onClick={() => onLook({ icon: "" })}>
          Aa
        </button>
        {LOOK_ICONS.map((i) => (
          <button key={i} type="button" role="radio" aria-checked={look.icon === i} title={i} onClick={() => onLook({ icon: i })}>
            <Icon name={i} />
          </button>
        ))}
      </div>
    </div>
  );
}
