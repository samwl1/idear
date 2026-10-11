import { useEffect, useState } from "react";
import { api, type EventView, type VerifyReport } from "../lib/api";
import type { WorkspaceSession } from "../lib/session";
import { Icon } from "./Icon";
import { PinButton } from "./PinnedNav";
import { isPinned, usePins } from "../lib/pins";

const TREE: Record<string, string> = {
  add: "Added to workspace",
  move: "Moved",
  rename: "Renamed folder",
  delete: "Deleted from workspace",
};
const NOUN: Record<string, string> = {
  workspace: "workspace",
  note: "note",
  whiteboard: "whiteboard",
  tracker: "project",
  view: "view",
  task: "task",
  column: "column",
  phase: "phase",
};
const VERB: Record<string, string> = {
  create: "Created",
  rename: "Renamed",
  edit: "Edited",
  tag: "Changed tags on",
  delete: "Deleted",
  move: "Moved",
  link: "Linked",
  unlink: "Unlinked",
  attach: "Added an image to",
};

const PEOPLE: Record<string, string> = {
  "member.add": "Added person",
  "member.role": "Changed role",
  "member.remove": "Removed person",
  "invite.create": "Created invite",
  "invite.cancel": "Cancelled invite",
};

function label(action: string): string {
  if (PEOPLE[action]) return PEOPLE[action];
  const [kind, verb] = action.split(".");
  if (kind === "tree") return TREE[verb] ?? action;
  return VERB[verb] && NOUN[kind] ? `${VERB[verb]} ${NOUN[kind]}` : action;
}

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

interface Props {
  session: WorkspaceSession;
  onError: (err: unknown) => void;
}

export function ActivityLog({ session, onError }: Props) {
  const [events, setEvents] = useState<EventView[] | null>(null);
  const pins = usePins(session.id);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = () => api.events(session.id).then((e) => live && setEvents(e), onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, onError]);

  const verify = async () => {
    setChecking(true);
    try {
      setReport(await api.verifyLog(session.id));
    } catch (e) {
      onError(e);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="activity">
      <header className="activity-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Every change in this workspace, signed by the device that made it.</p>
        </div>
        <PinButton workspace={session.id} pin={{ kind: "activity" }} pinned={isPinned(pins, { kind: "activity" })} />
        <button className="primary" onClick={verify} disabled={checking}>
          {checking ? "Verifying…" : "Verify log"}
        </button>
      </header>

      {report && (
        <div className={report.ok ? "report ok" : "report bad"} role="status">
          {report.ok ? (
            <p>
              <Icon name="check" /> Log intact: {report.events} events from {report.devices}{" "}
              {report.devices === 1 ? "device" : "devices"}, every hash and signature checks out.
            </p>
          ) : (
            <>
              <p>Log failed verification. These events were altered or removed outside the app:</p>
              <ul>
                {report.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {events === null ? null : events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Item</th>
                <th scope="col">Device</th>
                <th scope="col">Hash</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={`${e.device}:${e.seq}`}>
                  <td className="nowrap">{time.format(e.ts)}</td>
                  <td>{label(e.action)}</td>
                  <td>{e.targetTitle || <span className="muted">Deleted item</span>}</td>
                  <td className="nowrap">
                    {e.thisDevice ? "This device" : (e.deviceName ?? e.device.slice(0, 8))}
                    <span className="muted"> #{e.seq}</span>
                  </td>
                  <td className="hash" title={e.hash}>
                    {e.hash.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
