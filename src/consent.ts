/**
 * Consent as state you can reason about, rather than a banner that sets a
 * cookie and hopes.
 *
 * Under the GDPR and the ePrivacy Directive, consent has to be freely given,
 * specific, informed, as easy to withdraw as to give — and demonstrable. That
 * last word is the one products get wrong: a banner that flips a boolean can
 * say what the visitor chose, but not when, against which version of the
 * notice, or whether anything ran before they chose.
 *
 * So this keeps a record, and refuses the shapes that make a record worthless.
 */

/**
 * The categories almost every consent notice uses. `necessary` is not a choice
 * — it covers what the service cannot work without — and this type makes that
 * structural rather than a rule someone has to remember.
 */
export type Category = "necessary" | "preferences" | "statistics" | "marketing";

export const OPTIONAL_CATEGORIES: readonly Category[] = [
  "preferences",
  "statistics",
  "marketing",
] as const;

export const CATEGORIES: readonly Category[] = ["necessary", ...OPTIONAL_CATEGORIES] as const;

/** What the visitor decided, and enough context to defend it later. */
export type Decision = {
  readonly granted: readonly Category[];
  readonly at: string;
  /**
   * Which version of the notice they were shown. Without it, a later change to
   * the wording quietly rewrites what everyone is recorded as having agreed to.
   */
  readonly noticeVersion: string;
  /** How the decision was made, which is what an audit actually asks about. */
  readonly method: "accept-all" | "reject-all" | "custom" | "withdrawn";
};

export type State = {
  /** Null until the visitor has decided anything. */
  readonly decision: Decision | null;
  /** True while the notice should be on screen. */
  readonly pending: boolean;
};

export class InvalidDecision extends Error {}

export type Options = {
  readonly noticeVersion: string;
  /** Injectable so tests and server rendering are not at the mercy of a clock. */
  readonly now?: () => Date;
};

function stamp(options: Options): string {
  return (options.now?.() ?? new Date()).toISOString();
}

/** Nothing decided yet: the notice is due. */
export function unset(): State {
  return { decision: null, pending: true };
}

/**
 * Restore a decision from storage.
 *
 * A decision recorded against an older notice is **not** carried forward. The
 * visitor agreed to what that version said, and a new version is a new
 * question — quietly reusing the old answer is how "informed" stops being true.
 */
export function restore(decision: Decision | null, options: Options): State {
  if (!decision) return unset();
  if (decision.noticeVersion !== options.noticeVersion) return unset();
  if (decision.method === "withdrawn") return { decision, pending: true };
  return { decision, pending: false };
}

export function acceptAll(options: Options): State {
  return decide([...CATEGORIES], "accept-all", options);
}

export function rejectAll(options: Options): State {
  return decide(["necessary"], "reject-all", options);
}

/** A specific choice. `necessary` is added whether or not it was passed. */
export function accept(categories: readonly Category[], options: Options): State {
  for (const category of categories) {
    if (!CATEGORIES.includes(category)) {
      throw new InvalidDecision(`"${category}" is not a consent category`);
    }
  }
  const granted = ["necessary", ...OPTIONAL_CATEGORIES.filter((c) => categories.includes(c))];
  return decide(granted as Category[], "custom", options);
}

/**
 * Withdrawal. It must be as easy as giving consent, and it puts the notice back
 * on screen rather than silently leaving the visitor with no way to change
 * their mind again.
 */
export function withdraw(options: Options): State {
  return {
    decision: {
      granted: ["necessary"],
      at: stamp(options),
      noticeVersion: options.noticeVersion,
      method: "withdrawn",
    },
    pending: true,
  };
}

function decide(granted: Category[], method: Decision["method"], options: Options): State {
  return {
    decision: {
      granted,
      at: stamp(options),
      noticeVersion: options.noticeVersion,
      method,
    },
    pending: false,
  };
}

/**
 * Whether something in this category may run.
 *
 * Before any decision, only `necessary` may. That default is the whole point:
 * consent is opt-in, and code that treats "not answered yet" as permission is
 * the violation these banners exist to avoid.
 */
export function allows(state: State, category: Category): boolean {
  if (category === "necessary") return true;
  if (!state.decision || state.decision.method === "withdrawn") return false;
  return state.decision.granted.includes(category);
}
