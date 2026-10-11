import { useCallback, useEffect, useRef } from "react";
import { registerFlush } from "./pending";

/**
 * Returns schedule(value): calls fn(value) after `ms` of quiet.
 * Any pending call is flushed immediately on unmount, so nothing typed is lost
 * when switching notes.
 */
export function useDebounced<T>(fn: (value: T) => void, ms: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      const { value } = pending.current;
      pending.current = null;
      fnRef.current(value);
    }
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, ms);
    },
    [flush, ms],
  );

  useEffect(() => {
    const unregister = registerFlush(flush);
    return () => {
      unregister();
      flush();
    };
  }, [flush]);
  return schedule;
}
