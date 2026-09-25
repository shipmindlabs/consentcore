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
  asLog,
  CATEGORIES,
  hashNotice,
  InvalidDecision,
  OPTIONAL_CATEGORIES,
  rejectAll,
  restore,
  superseded,
  unset,
  withdraw,
  type Category,
  type Decision,
  type Options,
  type State,
  type StoredConsent,
} from "./consent.ts";

export {
  allowsPurpose,
  allowsVendor,
  categoriesOf,
  declarationHash,
  declare,
  grant,
  InvalidDeclaration,
  purpose,
  purposesOf,
  refuse,
  runnable,
  vendor,
  vendorsFor,
  type Declaration,
  type Purpose,
  type Vendor,
} from "./registry.ts";

export { Gate, type RunRecord } from "./gate.ts";

export {
  domHost,
  DuplicateTag,
  PURPOSE_ATTRIBUTE,
  TAG_ATTRIBUTE,
  Tags,
  type Tag,
  type TagDocument,
  type TagElement,
  type TagEvent,
  type TagHost,
  type TagRoot,
} from "./tags.ts";

export {
  chainHead,
  GENESIS,
  proof,
  PROOF_FORMAT,
  proofPreimage,
  sha256,
  verifyProof,
  type Proof,
  type ProofEntry,
  type ProofProblem,
  type Verification,
} from "./proof.ts";

export {
  CONSENT_MONTHS,
  COOKIE_LIMIT,
  cookieStore,
  expired,
  expiresAt,
  fresh,
  localStore,
  storageChannel,
  type Channel,
  type CookieJar,
  type CookieStoreOptions,
  type LocalStoreOptions,
  type StorageEvent,
  type StorageEventTarget,
  type StorageLike,
  type Store,
} from "./storage.ts";

export { useConsent, type UseConsent } from "./useConsent.ts";
