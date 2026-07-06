import { useCallback, useEffect, useRef, useState } from "react";

export interface Polling<T> {
  data: T | null;
  error: string;
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

/**
 * Poll `fn` on mount and every `intervalMs` while `enabled`. `deps` triggers an
 * immediate re-fetch when it changes (e.g. the selected window) instead of
 * waiting for the next tick. `fn` is read through a ref so a new closure each
 * render doesn't restart the interval.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
  deps: readonly unknown[] = [],
): Polling<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // A poll started before unmount (e.g. a tenant switch re-keys and remounts the
  // page subtree) can resolve afterwards; drop its result instead of setting
  // state on a dead component. Re-set true on mount for StrictMode remounts.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await fnRef.current();
      if (!mounted.current) return;
      setData(d);
      setUpdatedAt(Date.now());
      setError("");
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    if (!enabled) return () => void (cancelled = true);
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, intervalMs, enabled, ...deps]);

  return { data, error, updatedAt, refresh };
}
