import { useEffect, useRef } from "react";

/**
 * "Something in evals changed": fired when an Evals agent turn finishes,
 * since the agent may have created a question set, edited checks, started a
 * run or suggested notes. Pages fetch their own data, so each listens and
 * reloads what it shows. One event, many listeners — no page needs to know
 * what the agent did.
 */
const EVENT = "evals:changed";

export function notifyEvalsChanged() {
  window.dispatchEvent(new Event(EVENT));
}

/** Call `reload` whenever evals change. The latest callback is used; it need not be stable. */
export function useEvalsChanged(reload: () => void) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const on = () => latest.current();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
