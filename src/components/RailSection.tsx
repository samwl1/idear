import type { ReactNode } from "react";
import { useSectionOpen } from "../lib/pins";
import { Icon } from "./Icon";

/** A collapsible section of the sidebar, remembered per device. */
export function RailSection({
  id,
  title,
  icon,
  actions,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  /** Buttons on the right of the header. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useSectionOpen(id);
  return (
    <section className={`rail-section ${className ?? ""}`} data-open={open || undefined}>
      <div className="rail-section-head">
        <button className="rail-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron" className={open ? "chev open" : "chev"} />
          {icon}
          <h2>{title}</h2>
        </button>
        {actions && <span className="rail-section-actions">{actions}</span>}
      </div>
      {open && children}
    </section>
  );
}
