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
  /**
   * A fingerprint of the notice text itself. The version string is a promise
   * someone has to remember to keep; the hash is checkable, and it catches the
   * edit that changed what the notice said without changing what it was called.
   * Empty when the caller chose not to fingerprint the notice.
   */
  readonly noticeHash: string;
  /** How the decision was made, which is what an audit actually asks about. */
  readonly method: "accept-all" | "reject-all" | "custom" | "withdrawn";
};

export type State = {
  /** Null until the visitor has decided anything against the current notice. */
  readonly decision: Decision | null;
  /** True while the notice should be on screen. */
  readonly pending: boolean;
  /**
   * Every decision this visitor has made, oldest first. A new notice supersedes
   * the previous answer but never edits or drops it: the log is the part that
   * makes the record demonstrable.
   */
  readonly log: readonly Decision[];
};

/** What storage may hand back: nothing, one decision, or the whole log. */
export type StoredConsent = Decision | readonly Decision[] | null;

export class InvalidDecision extends Error {}

export type Options = {
  readonly noticeVersion: string;
  /** Fingerprint of the notice text; `hashNotice` produces one. */
  readonly noticeHash?: string;
  /** Injectable so tests and server rendering are not at the mercy of a clock. */
  readonly now?: () => Date;
};

/**
 * A fingerprint of the notice text: FNV-1a, 64-bit, hex.
 *
 * Not a security hash and not trying to be. The only question the record asks
 * is "is this still the same text", and answering it needs no dependency, no
 * async digest and no ceremony.
 */
export function hashNotice(text: string): string {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Older records held a single decision; newer ones hold the whole log. */
export function asLog(stored: StoredConsent): readonly Decision[] {
  if (!stored) return [];
  return "method" in stored ? [stored] : [...stored];
}

function stamp(options: Options): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function answersCurrentNotice(decision: Decision, options: Options): boolean {
  return (
    decision.noticeVersion === options.noticeVersion &&
    (decision.noticeHash ?? "") === (options.noticeHash ?? "")
  );
}

/** Nothing decided yet: the notice is due. */
export function unset(log: readonly Decision[] = []): State {
  return { decision: null, pending: true, log };
}

/**
 * Restore from storage.
 *
 * A decision recorded against an older notice — a different version, or the
 * same version whose text was edited — is **not** carried forward. The visitor
 * agreed to what that notice said, and a new notice is a new question; quietly
 * reusing the old answer is how "informed" stops being true. The superseded
 * decision stays in the log, because deleting it would lose the one thing the
 * record exists to prove.
 */
export function restore(stored: StoredConsent, options: Options): State {
  const log = asLog(stored);
  const latest = log.at(-1) ?? null;
  if (!latest) return unset(log);
  if (!answersCurrentNotice(latest, options)) return unset(log);
  if (latest.method === "withdrawn") return { decision: latest, pending: true, log };
  return { decision: latest, pending: false, log };
}

/**
 * The decision a new notice replaced, while the new one is unanswered. Useful
 * for a banner that wants to say what changed rather than just reappearing.
 */
export function superseded(state: State): Decision | null {
  if (state.decision) return null;
  return state.log.at(-1) ?? null;
}

export function acceptAll(options: Options, previous?: State): State {
  return decide([...CATEGORIES], "accept-all", options, previous);
}

export function rejectAll(options: Options, previous?: State): State {
  return decide(["necessary"], "reject-all", options, previous);
}

/** A specific choice. `necessary` is added whether or not it was passed. */
export function accept(
  categories: readonly Category[],
  options: Options,
  previous?: State,
): State {
  for (const category of categories) {
    if (!CATEGORIES.includes(category)) {
      throw new InvalidDecision(`"${category}" is not a consent category`);
    }
  }
  const granted = ["necessary", ...OPTIONAL_CATEGORIES.filter((c) => categories.includes(c))];
  return decide(granted as Category[], "custom", options, previous);
}

/**
 * Withdrawal. It must be as easy as giving consent, and it puts the notice back
 * on screen rather than silently leaving the visitor with no way to change
 * their mind again.
 */
export function withdraw(options: Options, previous?: State): State {
  return decide(["necessary"], "withdrawn", options, previous);
}

function decide(
  granted: Category[],
  method: Decision["method"],
  options: Options,
  previous?: State,
): State {
  const decision: Decision = {
    granted,
    at: stamp(options),
    noticeVersion: options.noticeVersion,
    noticeHash: options.noticeHash ?? "",
    method,
  };
  return {
    decision,
    pending: method === "withdrawn",
    log: [...(previous?.log ?? []), decision],
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
