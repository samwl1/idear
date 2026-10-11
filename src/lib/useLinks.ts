import { useEffect, useState } from "react";
import { api, type EntityKind, type Links } from "./api";
import type { WorkspaceSession } from "./session";

/** An item's links in both directions, kept current. Null until loaded. */
export function useLinks(session: WorkspaceSession, id: string, onError: (err: unknown) => void): Links | null {
  const [links, setLinks] = useState<Links | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => api.linksOf(session.id, id).then((l) => live && setLinks(l), onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, id, onError]);
  return links;
}

export interface LinkTarget {
  id: string;
  kind: EntityKind;
  title: string;
  /** Where it lives, for tasks and phases. */
  detail: string;
  tracker: string | null;
}

/** Everything a note can be attached to, kept current. */
export function useLinkTargets(session: WorkspaceSession, onError: (err: unknown) => void): LinkTarget[] {
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      api
        .runView(session.id, {
          types: ["note", "whiteboard", "tracker", "task", "phase"],
          tags: [],
          text: "",
          updatedWithinDays: null,
          sort: "title",
          statuses: [],
          assignee: "",
          keys: [],
        })
        .then((rows) => {
          if (!live) return;
          setTargets(
            rows.map((r) => ({
              id: r.id,
              kind: r.kind,
              title: r.kind === "task" && r.key ? `${r.key} ${r.title}` : r.title,
              detail:
                r.kind === "task"
                  ? `Task in ${r.trackerTitle ?? "a project"}`
                  : r.kind === "phase"
                    ? `Phase in ${r.trackerTitle ?? "a project"}`
                    : KIND_LABEL[r.kind],
              tracker: r.tracker,
            })),
          );
        }, onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, onError]);
  return targets;
}

const KIND_LABEL: Record<EntityKind, string> = {
  note: "Note",
  whiteboard: "Whiteboard",
  tracker: "Project",
  folder: "Folder",
  task: "Task",
  phase: "Phase",
};
