/**
 * The React binding. Thin on purpose — the decisions live in consent.ts, which
 * is where they can be tested without a renderer.
 */

import { useCallback, useMemo, useState } from "react";

import {
  accept,
  acceptAll,
  allows,
  rejectAll,
  restore,
  withdraw,
  type Category,
  type Decision,
  type Options,
  type State,
} from "./consent.ts";

/** Somewhere to keep the decision between visits. */
export type Store = {
  read(): Decision | null;
  write(decision: Decision | null): void;
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
        return raw ? (JSON.parse(raw) as Decision) : null;
      } catch {
        return null;
      }
    },
    write(decision) {
      try {
        if (decision) globalThis.localStorage?.setItem(key, JSON.stringify(decision));
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
      store.write(next.decision);
      // Read it back: a write that silently did nothing is the case worth
      // knowing about, and it is cheap to check.
      const stored = store.read();
      setPersisted(stored?.at === next.decision?.at);
    },
    [store],
  );

  return {
    state,
    pending: state.pending,
    decision: state.decision,
    persisted,
    allows: useCallback((category: Category) => allows(state, category), [state]),
    acceptAll: useCallback(() => commit(acceptAll(options)), [commit, options]),
    rejectAll: useCallback(() => commit(rejectAll(options)), [commit, options]),
    accept: useCallback(
      (categories: readonly Category[]) => commit(accept(categories, options)),
      [commit, options],
    ),
    withdraw: useCallback(() => commit(withdraw(options)), [commit, options]),
  };
}
