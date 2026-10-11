import { Icon } from "./Icon";
import type { WorkspaceSession } from "../lib/session";
import { isPopout, popOut } from "../lib/popout";
import { showError } from "../lib/toast";

/** Opens the page in its own window. Hidden inside a popped-out window. */
export function PopOutButton({ session, id }: { session: WorkspaceSession; id: string }) {
  if (isPopout()) return null;
  return (
    <button
      className="tool"
      aria-label="Open in a new window"
      title="Open in a new window"
      onClick={() => {
        const title = session.node(id)?.title;
        popOut(session.id, id, title ? `${title} – idear` : "idear").catch((e) => showError(e instanceof Error ? e.message : String(e)));
      }}
    >
      <Icon name="popout" />
    </button>
  );
}
