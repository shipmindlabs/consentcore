/**
 * The React binding. Thin on purpose — the decisions live in consent.ts, which
 * is where they can be tested without a renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
} from "./consent.ts";
import { localStore, type Store } from "./storage.ts";

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

  // Held in a ref so a caller passing an options literal — which is every
  // caller — does not resubscribe on every render.
  const notice = useRef(options);
  notice.current = options;

  // A visitor with the site open twice who withdraws in one tab has withdrawn.
  // The record is the shared one, so this tab follows it rather than keeping an
  // answer that has already been changed.
  useEffect(() => {
    return store.subscribe?.(() => setState(restore(store.read(), notice.current)));
  }, [store]);

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
