// Edits waiting on a debounce timer. Before remote changes are merged in,
// everything here is saved first, so nothing typed is lost or overwritten.
type Flush = () => void;

const flushers = new Set<Flush>();

export function registerFlush(fn: Flush): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export function flushAll() {
  flushers.forEach((fn) => fn());
}
