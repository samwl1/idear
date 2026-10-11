import { useEffect, useState } from "react";
import { api, type EntityKind } from "./api";
import type { WorkspaceSession } from "./session";

export type ItemLookup = Map<string, { title: string; kind: EntityKind }>;

/** Titles of every note, whiteboard, and project, kept current as they change. Null until loaded. */
export function useItemLookup(session: WorkspaceSession, onError: (err: unknown) => void): ItemLookup | null {
  const [lookup, setLookup] = useState<ItemLookup | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      api
        .runView(session.id, {
          types: ["note", "whiteboard", "tracker"],
          tags: [],
          text: "",
          updatedWithinDays: null,
          sort: "title",
          statuses: [],
          assignee: "",
          keys: [],
        })
        .then((rows) => {
          if (live) setLookup(new Map(rows.map((r) => [r.id, { title: r.title, kind: r.kind }])));
        }, onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, onError]);
  return lookup;
}
