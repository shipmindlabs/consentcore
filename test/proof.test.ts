/**
 * The export a reviewer reads. The tests that matter here are the ones where
 * the file has been edited after the fact.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accept,
  acceptAll,
  chainHead,
  GENESIS,
  hashNotice,
  proof,
  PROOF_FORMAT,
  proofPreimage,
  sha256,
  unset,
  verifyProof,
  withdraw,
  type Options,
  type Proof,
} from "../src/index.ts";

const options: Options = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now: () => new Date("2026-08-16T10:00:00Z"),
};

function threeDecisions() {
  let state = accept(["statistics"], options);
  state = acceptAll(options, state);
  state = withdraw(options, state);
  return state;
}

/** A parsed export, editable the way a text editor can edit the file. */
type Edited = { format: string; entries: Record<string, unknown>[] };

function asEdited(document: Proof): Edited {
  return structuredClone(document) as unknown as Edited;
}

// If the digest is wrong, nothing else here means anything.
test("the digest matches the published SHA-256 vectors", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("every decision becomes an entry linked to the one before it", () => {
  const document = proof(threeDecisions());

  assert.equal(document.format, PROOF_FORMAT);
  assert.equal(document.entries.length, 3);
  assert.equal(document.entries[0].previous, GENESIS);
  assert.deepEqual(document.entries[0].purposes, ["necessary", "statistics"]);
  assert.deepEqual(
    document.entries.map((entry) => entry.method),
    ["custom", "accept-all", "withdrawn"],
  );
  for (const entry of document.entries) assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.equal(document.entries[1].previous, document.entries[0].hash);
  assert.equal(document.entries[2].previous, document.entries[1].hash);
  assert.equal(chainHead(document), document.entries[2].hash);
  assert.deepEqual(verifyProof(document), { ok: true, entries: 3, problems: [] });
});

// The point of the export is that verifying it needs no code from here.
test("an entry hash is a documented preimage anyone can recompute", () => {
  const [entry] = proof(acceptAll(options)).entries;
  const { hash, ...body } = entry;

  assert.equal(sha256(proofPreimage(body)), hash);
  assert.equal(
    proofPreimage(body),
    JSON.stringify([
      PROOF_FORMAT,
      0,
      "2026-08-16T10:00:00.000Z",
      "accept-all",
      ["necessary", "preferences", "statistics", "marketing"],
      "2026-08-01",
      options.noticeHash,
      GENESIS,
    ]),
  );
});

test("the chain is derived, so the same log always exports the same bytes", () => {
  const state = threeDecisions();
  assert.equal(JSON.stringify(proof(state)), JSON.stringify(proof(state.log)));
});

test("an edited purpose no longer matches its hash", () => {
  const document = asEdited(proof(threeDecisions()));
  document.entries[0].purposes = ["necessary", "statistics", "marketing"];

  const result = verifyProof(document);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.problems.map((problem) => problem.index),
    [0],
  );
});

test("a decision removed from the middle breaks the chain", () => {
  const document = asEdited(proof(threeDecisions()));
  document.entries.splice(1, 1);

  const result = verifyProof(document);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.reason.includes("previous")));
  assert.ok(result.problems.some((problem) => problem.reason.includes("claims index 2")));
});

test("reordering entries is caught even though no field was edited", () => {
  const document = asEdited(proof(threeDecisions()));
  const [first, second, third] = document.entries;
  document.entries = [first, third, second];

  assert.equal(verifyProof(document).ok, false);
});

test("an appended entry has to be linked, not merely well formed", () => {
  const document = asEdited(proof(threeDecisions()));
  const forged = structuredClone(document.entries[2]);
  forged.index = 3;
  forged.purposes = ["necessary", "marketing"];
  document.entries.push(forged);

  const result = verifyProof(document);
  assert.equal(result.ok, false);
  assert.ok(result.problems.every((problem) => problem.index === 3));
});

// Hashes verifying is not the same as the log making sense.
test("a timestamp that goes backwards is reported", () => {
  const first = acceptAll(options);
  const state = withdraw({ ...options, now: () => new Date("2026-08-15T10:00:00Z") }, first);

  const result = verifyProof(proof(state));
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.problems.map((problem) => problem.index),
    [1],
  );
});

// Every field comes from a caller, so no field may impersonate two.
test("a field cannot be shifted into its neighbour", () => {
  const at = "2026-08-16T10:00:00.000Z";
  const base = { granted: ["necessary"], at, method: "custom" } as const;
  const honest = proof([{ ...base, noticeVersion: "v1", noticeHash: "abc" }]);
  const smuggled = proof([{ ...base, noticeVersion: 'v1","abc', noticeHash: "" }]);

  assert.notEqual(honest.entries[0].hash, smuggled.entries[0].hash);
});

// A chain is tamper-evident, not tamper-proof: whoever holds the log can
// recompute every hash. It shows an edit made in place. It cannot show a
// rewrite, which is why the head hash is worth anchoring somewhere else.
test("a wholesale rewrite verifies, which is the limit of a chain", () => {
  const rewritten = proof([
    {
      granted: ["necessary", "marketing"],
      at: "2026-08-16T10:00:00.000Z",
      noticeVersion: "2026-08-01",
      noticeHash: "",
      method: "accept-all",
    },
  ]);

  assert.equal(verifyProof(rewritten).ok, true);
});

test("a document that is not a proof is refused rather than trusted", () => {
  const bad: unknown[] = [
    null,
    42,
    "{}",
    {},
    { format: PROOF_FORMAT },
    { format: "other/proof@9", entries: [] },
    { format: PROOF_FORMAT, entries: [{ index: 0, at: "2026-08-16T10:00:00.000Z" }] },
  ];
  for (const document of bad) {
    assert.equal(verifyProof(document).ok, false, JSON.stringify(document));
  }
});

test("an empty log is an empty chain, not an error", () => {
  const document = proof(unset());

  assert.deepEqual(document.entries, []);
  assert.equal(chainHead(document), GENESIS);
  assert.equal(verifyProof(document).ok, true);
});
