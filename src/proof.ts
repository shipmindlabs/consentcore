/**
 * The decision log as a hash chain, and a JSON export a reviewer can check
 * without running this library.
 *
 * `state.log` is append-only in memory, which is a promise this code makes to
 * itself. A reviewer has no reason to accept it: a JSON file of decisions can
 * be edited in any text editor, and nothing in the shape of it shows that it
 * was. Chaining each entry to the hash of the one before makes an edit visible
 * — the entry stops matching its own hash, and everything after it stops
 * matching the chain.
 *
 * The chain is derived, never stored. It is a pure function of the log, so two
 * exports of the same log are byte-identical and anyone holding the log can
 * recompute it.
 */

import type { Category, Decision, State } from "./consent.ts";

/** Names the document and the preimage, and is hashed into every entry. */
export const PROOF_FORMAT = "consentcore/proof@1";

/** What the first entry points at, so entry zero has the shape of every other. */
export const GENESIS = "0".repeat(64);

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(word: number, bits: number): number {
  return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

/**
 * SHA-256 of a string, hex.
 *
 * `hashNotice` is FNV-1a because it only has to answer "is this the same text",
 * and the only reader is this library. The chain is read by someone who does
 * not trust whoever wrote it, so it uses the digest they already have a tool
 * for: `openssl dgst -sha256`, `createHash("sha256")`, `hashlib.sha256`.
 * Synchronous, so exporting a proof stays a plain call rather than a promise
 * threaded through the API.
 */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bits = BigInt(bytes.length) * 8n;
  view.setUint32(padded.length - 8, Number((bits >> 32n) & 0xffffffffn));
  view.setUint32(padded.length - 4, Number(bits & 0xffffffffn));

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let block = 0; block < blocks; block += 1) {
    const offset = block * 64;
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** One decision, as it appears in an export. */
export type ProofEntry = {
  readonly index: number;
  readonly at: string;
  /** The categories the visitor granted. */
  readonly purposes: readonly Category[];
  readonly method: Decision["method"];
  readonly noticeVersion: string;
  readonly noticeHash: string;
  /** The hash of the entry before this one, or `GENESIS` for the first. */
  readonly previous: string;
  readonly hash: string;
};

export type Proof = {
  readonly format: string;
  readonly entries: readonly ProofEntry[];
};

export type ProofProblem = {
  /** Which entry, or null when the document itself is the problem. */
  readonly index: number | null;
  readonly reason: string;
};

export type Verification = {
  readonly ok: boolean;
  readonly entries: number;
  /** Every problem found, not only the first: a reviewer wants the whole list. */
  readonly problems: readonly ProofProblem[];
};

/**
 * The exact string an entry's hash is taken over.
 *
 * A JSON array rather than a joined line, because every field here comes from a
 * caller: a `noticeVersion` containing a quote or a newline must not be able to
 * pass itself off as two fields. JSON escaping settles that, and the encoding
 * of an array of strings has no key order to argue about.
 */
export function proofPreimage(entry: Omit<ProofEntry, "hash">): string {
  return JSON.stringify([
    PROOF_FORMAT,
    entry.index,
    entry.at,
    entry.method,
    [...entry.purposes],
    entry.noticeVersion,
    entry.noticeHash,
    entry.previous,
  ]);
}

/** The log as a chained document, ready for `JSON.stringify`. */
export function proof(source: State | readonly Decision[]): Proof {
  const log = "log" in source ? source.log : source;
  const entries: ProofEntry[] = [];
  let previous = GENESIS;

  for (const [index, decision] of log.entries()) {
    const body = {
      index,
      at: decision.at,
      purposes: [...decision.granted],
      method: decision.method,
      noticeVersion: decision.noticeVersion,
      noticeHash: decision.noticeHash ?? "",
      previous,
    };
    const hash = sha256(proofPreimage(body));
    entries.push({ ...body, hash });
    previous = hash;
  }

  return { format: PROOF_FORMAT, entries };
}

/**
 * The last hash, which covers every entry before it. This is the one value
 * worth putting somewhere the writer of the log does not control.
 */
export function chainHead(document: Proof): string {
  return document.entries.at(-1)?.hash ?? GENESIS;
}

/**
 * Check a parsed export. Takes `unknown` because the interesting case is a file
 * from somewhere else, and reports problems rather than throwing, since "which
 * entry, and what about it" is the answer a reviewer needs.
 */
export function verifyProof(document: unknown): Verification {
  const problems: ProofProblem[] = [];
  const fail = (index: number | null, reason: string) => {
    problems.push({ index, reason });
  };

  if (typeof document !== "object" || document === null) {
    return { ok: false, entries: 0, problems: [{ index: null, reason: "not a proof document" }] };
  }

  const doc = document as { format?: unknown; entries?: unknown };
  if (doc.format !== PROOF_FORMAT) {
    fail(null, `unknown format ${JSON.stringify(doc.format)}`);
  }
  if (!Array.isArray(doc.entries)) {
    fail(null, "entries is not a list");
    return { ok: false, entries: 0, problems };
  }

  const entries: unknown[] = doc.entries;
  let previous = GENESIS;
  let last = "";

  for (const [index, raw] of entries.entries()) {
    const entry = asEntry(raw);
    if (!entry) {
      fail(index, "entry has missing or wrongly typed fields; verification stopped here");
      break;
    }
    if (entry.index !== index) fail(index, `entry claims index ${entry.index}`);
    if (entry.previous !== previous) fail(index, "previous does not match the entry before it");
    if (entry.hash !== sha256(proofPreimage(entry))) {
      fail(index, "hash does not match the entry contents");
    }
    if (last && entry.at < last) fail(index, `timestamp ${entry.at} is earlier than ${last}`);

    last = entry.at;
    previous = entry.hash;
  }

  return { ok: problems.length === 0, entries: entries.length, problems };
}

function asEntry(raw: unknown): ProofEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.index !== "number" || !Number.isInteger(entry.index) || entry.index < 0) {
    return null;
  }
  for (const field of ["at", "method", "noticeVersion", "noticeHash", "previous", "hash"]) {
    if (typeof entry[field] !== "string") return null;
  }
  if (!Array.isArray(entry.purposes)) return null;
  if (entry.purposes.some((purpose) => typeof purpose !== "string")) return null;
  return entry as unknown as ProofEntry;
}
