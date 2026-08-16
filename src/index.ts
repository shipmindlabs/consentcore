/**
 * consentcore — GDPR consent as state you can reason about: what was chosen,
 * when, against which notice, and what was allowed to run before it.
 *
 * Not legal advice. See README.md.
 */

export {
  accept,
  acceptAll,
  allows,
  CATEGORIES,
  InvalidDecision,
  OPTIONAL_CATEGORIES,
  rejectAll,
  restore,
  unset,
  withdraw,
  type Category,
  type Decision,
  type Options,
  type State,
} from "./consent.ts";

export { Gate, type RunRecord } from "./gate.ts";

export { localStore, useConsent, type Store, type UseConsent } from "./useConsent.ts";
