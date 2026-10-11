import type { ViewDef } from "../lib/session";
import { Icon, iconName } from "./Icon";
import { useCanEdit } from "../lib/access";
import { isPinned, usePins, type Pin } from "../lib/pins";
import { PinButton } from "./PinnedNav";
import { RailSection } from "./RailSection";

export type ViewsPane = { type: "activity" } | { type: "hub" } | { type: "view"; id: string };

interface Props {
  workspace: string;
  views: { id: string; def: ViewDef }[];
  active: ViewsPane | null;
  onSelect: (pane: ViewsPane) => void;
  onCreate: () => void;
}

export function ViewsNav({ workspace, views, active, onSelect, onCreate }: Props) {
  const canEdit = useCanEdit();
  const pins = usePins(workspace);
  const is = (p: ViewsPane) =>
    active?.type === p.type && (p.type !== "view" || (active as { id: string }).id === p.id);

  const row = (pane: ViewsPane, pin: Pin, icon: Parameters<typeof Icon>[0]["name"], label: string) => (
    <li className="pin-row">
      <button className="nav-item" data-active={is(pane) || undefined} onClick={() => onSelect(pane)}>
        <Icon name={icon} /> <span className="row-label">{label}</span>
      </button>
      <PinButton workspace={workspace} pin={pin} pinned={isPinned(pins, pin)} />
    </li>
  );

  return (
    <RailSection
      id="views"
      className="views-nav"
      title="Views"
      actions={
        canEdit && (
          <button className="tool" title="New view" aria-label="New view" onClick={onCreate}>
            <Icon name="plus" />
          </button>
        )
      }
    >
      <ul>
        {row({ type: "hub" }, { kind: "hub" }, "note", "Notes Hub")}
        {row({ type: "activity" }, { kind: "activity" }, "log", "Activity")}
        {views.map(({ id, def }) => (
          <li key={id} className="pin-row">
            <button
              className="nav-item"
              data-active={is({ type: "view", id }) || undefined}
              onClick={() => onSelect({ type: "view", id })}
            >
              <Icon name={iconName(def.icon)} /> <span className="row-label">{def.name || "Untitled view"}</span>
            </button>
            <PinButton workspace={workspace} pin={{ kind: "view", id }} pinned={isPinned(pins, { kind: "view", id })} />
          </li>
        ))}
      </ul>
    </RailSection>
  );
}
