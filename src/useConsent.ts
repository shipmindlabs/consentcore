/**
 * The React binding. Thin on purpose — the decisions live in consent.ts, which
 * is where they can be tested without a renderer.
 */

import { useCallback, useMemo, useState } from "react";

import {
  accept,
  acceptAll,
  allows,
  asLog,
  rejectAll,
  restore,
  superseded,
  withdraw,
  type Category,
  type Decision,
  type Options,
  type State,
  type StoredConsent,
} from "./consent.ts";

/** Somewhere to keep the decisions between visits. */
export type Store = {
  read(): StoredConsent;
  /**
   * The whole log, not only the latest decision: a superseded answer is part of
   * the record, and a store that keeps just the last one cannot show it.
   */
  write(log: readonly Decision[]): void;
};

/**
 * A store backed by localStorage, written so that a blocked or full storage
 * does not take the page down with it.
 *
 * Storage failing is not exotic: private browsing, quota, and a browser
 * setting that blocks it entirely are all ordinary. Losing the record is bad;
 * throwing inside a banner is worse, because then nobody can consent at all.
 */
export function localStore(key = "consent"): Store {
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as StoredConsent) : null;
      } catch {
        return null;
      }
    },
    write(log) {
      try {
        if (log.length) globalThis.localStorage?.setItem(key, JSON.stringify(log));
        else globalThis.localStorage?.removeItem(key);
      } catch {
        // Recorded nowhere, which the caller can see via `persisted`.
      }
    },
  };
}

export type UseConsent = {
  readonly state: State;
  readonly pending: boolean;
  readonly decision: Decision | null;
  /** Every decision made, oldest first, including ones a new notice replaced. */
  readonly log: readonly Decision[];
  /** The decision the current notice replaced, while it is unanswered. */
  readonly superseded: Decision | null;
  /** Whether the decision reached storage. False means it will be asked again. */
  readonly persisted: boolean;
  allows(category: Category): boolean;
  acceptAll(): void;
  rejectAll(): void;
  accept(categories: readonly Category[]): void;
  withdraw(): void;
};

export function useConsent(options: Options & { store?: Store }): UseConsent {
  const store = useMemo(() => options.store ?? localStore(), [options.store]);
  const [state, setState] = useState<State>(() => restore(store.read(), options));
  const [persisted, setPersisted] = useState(true);

  const commit = useCallback(
    (next: State) => {
      setState(next);
      store.write(next.log);
      // Read it back: a write that silently did nothing is the case worth
      // knowing about, and it is cheap to check.
      const stored = asLog(store.read()).at(-1);
      setPersisted(stored?.at === next.log.at(-1)?.at);
    },
    [store],
  );

  return {
    state,
    pending: state.pending,
    decision: state.decision,
    log: state.log,
    superseded: superseded(state),
    persisted,
    allows: useCallback((category: Category) => allows(state, category), [state]),
    acceptAll: useCallback(() => commit(acceptAll(options, state)), [commit, options, state]),
    rejectAll: useCallback(() => commit(rejectAll(options, state)), [commit, options, state]),
    accept: useCallback(
      (categories: readonly Category[]) => commit(accept(categories, options, state)),
      [commit, options, state],
    ),
    withdraw: useCallback(() => commit(withdraw(options, state)), [commit, options, state]),
  };
}
