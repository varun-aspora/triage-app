// Fetches data for a page, with optional polling. A request is aborted when
// the component unmounts or deps change. Polling pauses while the tab is
// hidden and stops once pollWhile returns false (for example, a run that has
// finished).

import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';

export type ApiState<T> = {
  data: T | undefined;
  error: unknown;
  /** True until the first answer for the current deps; polls do not set it again. */
  loading: boolean;
  /** Fetches again now. */
  reload: () => void;
};

export type UseApiOptions<T> = {
  pollMs?: number;
  pollWhile?: (data: T) => boolean;
};

export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: DependencyList, options: UseApiOptions<T> = {}): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  const optsRef = useRef(options);
  fnRef.current = fn;
  optsRef.current = options;

  // New deps mean a different resource: drop what was shown for the old one.
  useEffect(() => {
    setData(undefined);
    setError(undefined);
    setLoading(true);
  }, deps);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingForVisible = false;

    const onVisible = () => {
      if (document.visibilityState === 'visible' && waitingForVisible) {
        waitingForVisible = false;
        void run();
      }
    };

    const schedule = (latest: T) => {
      const { pollMs, pollWhile } = optsRef.current;
      if (pollMs === undefined || pollMs <= 0) return;
      if (pollWhile !== undefined && !pollWhile(latest)) return;
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden') waitingForVisible = true;
        else void run();
      }, pollMs);
    };

    const run = async () => {
      try {
        const result = await fnRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setData(result);
        setError(undefined);
        setLoading(false);
        schedule(result);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err);
        setLoading(false);
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    void run();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
