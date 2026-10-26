import { useEffect, useMemo, useState } from "react";
import { api, type TreeNode } from "./api";
import type { WorkspaceSession } from "./session";

export interface TreeIndex {
  nodes: TreeNode[];
  byId: Map<string, TreeNode>;
  /** Children of each node (null: the top level), in sidebar order. */
  children: Map<string | null, TreeNode[]>;
}

/** The workspace's folders and pages, kept current as they change. */
export function useTree(session: WorkspaceSession, onError: (err: unknown) => void): TreeIndex {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () => api.tree(session.id).then((n) => live && setNodes(n), onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    // The index was rebuilt behind the session's back (Activity → Rebuild index).
    window.addEventListener("tree-changed", refresh);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener("tree-changed", refresh);
    };
  }, [session, onError]);

  return useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map<string | null, TreeNode[]>();
    // Two devices moving pages into each other offline can merge into a loop.
    // Nodes in a loop show at the top level (with everything under them), as
    // do nodes whose parent is gone.
    const inLoop = (id: string): boolean => {
      const seen = new Set<string>();
      let cur = byId.get(id)?.parent ?? null;
      while (cur && byId.has(cur) && !seen.has(cur)) {
        if (cur === id) return true;
        seen.add(cur);
        cur = byId.get(cur)?.parent ?? null;
      }
      return false;
    };
    for (const n of nodes) {
      const parent = n.parent && byId.has(n.parent) && !inLoop(n.id) ? n.parent : null;
      const list = children.get(parent) ?? [];
      list.push(n);
      children.set(parent, list);
    }
    return { nodes, byId, children };
  }, [nodes]);
}

/** Ancestors of a node, top level first. */
export function ancestors(tree: TreeIndex, id: string): TreeNode[] {
  const out: TreeNode[] = [];
  const seen = new Set<string>();
  for (let cur = tree.byId.get(id)?.parent ?? null; cur && !seen.has(cur); ) {
    seen.add(cur);
    const n = tree.byId.get(cur);
    if (!n) break;
    out.unshift(n);
    cur = n.parent;
  }
  return out;
}
