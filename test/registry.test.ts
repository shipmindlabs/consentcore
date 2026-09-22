/**
 * The declaration. What matters here is that it is checked before anything is
 * shown to a visitor, and that refusing a purpose is the same call as granting
 * one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptAll,
  allowsPurpose,
  allowsVendor,
  categoriesOf,
  declarationHash,
  declare,
  grant,
  hashNotice,
  InvalidDeclaration,
  purposesOf,
  refuse,
  runnable,
  unset,
  vendorsFor,
  withdraw,
  type Options,
  type Purpose,
} from "../src/index.ts";

const options: Options = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now: () => new Date("2026-08-16T10:00:00Z"),
};

const session: Purpose = {
  id: "session",
  category: "necessary",
  name: "Keeping you signed in",
  description: "A cookie that holds your session while you use the site.",
};

const audience: Purpose = {
  id: "audience",
  category: "statistics",
  name: "Counting visits",
  description: "Which pages are read, in aggregate.",
};

const retargeting: Purpose = {
  id: "retargeting",
  category: "marketing",
  name: "Advertising",
  description: "Showing you ads for this site on other sites.",
};

const declaration = declare({
  purposes: [session, audience, retargeting],
  vendors: [
    {
      id: "acme-analytics",
      name: "Acme Analytics",
      purposes: ["audience"],
      policy: "https://acme.example/privacy",
      cookies: ["_acme"],
      transfers: "US",
    },
    { id: "adnet", name: "AdNet", purposes: ["audience", "retargeting"] },
    { id: "first-party", name: "This site", purposes: ["session"] },
  ],
});

// A vendor under a purpose nobody declared is a notice that cannot be written.
test("a vendor may only name purposes that were declared", () => {
  assert.throws(
    () =>
      declare({
        purposes: [audience],
        vendors: [{ id: "adnet", name: "AdNet", purposes: ["retargeting"] }],
      }),
    InvalidDeclaration,
  );
});

// Informed consent needs something to be informed by.
test("a purpose with nothing to show the visitor is refused", () => {
  const wordless = { id: "audience", category: "statistics", name: "Counting visits" };
  assert.throws(
    () => declare({ purposes: [wordless as unknown as Purpose], vendors: [] }),
    InvalidDeclaration,
  );
});

test("an id used twice is refused, since one of the two could never be shown", () => {
  assert.throws(
    () => declare({ purposes: [audience, { ...audience, name: "Analytics" }], vendors: [] }),
    InvalidDeclaration,
  );
  assert.throws(
    () =>
      declare({
        purposes: [audience],
        vendors: [
          { id: "adnet", name: "AdNet", purposes: ["audience"] },
          { id: "adnet", name: "AdNet Ltd", purposes: ["audience"] },
        ],
      }),
    InvalidDeclaration,
  );
});

test("a vendor with no purpose, and a purpose with no category, are refused", () => {
  assert.throws(
    () =>
      declare({
        purposes: [audience],
        vendors: [{ id: "adnet", name: "AdNet", purposes: [] }],
      }),
    InvalidDeclaration,
  );
  assert.throws(
    () => declare({ purposes: [{ ...audience, category: "analytics" as never }], vendors: [] }),
    InvalidDeclaration,
  );
});

test("before any decision only necessary purposes are allowed", () => {
  const state = unset();

  assert.equal(allowsPurpose(declaration, state, "session"), true);
  assert.equal(allowsPurpose(declaration, state, "audience"), false);
  assert.equal(allowsPurpose(declaration, state, "retargeting"), false);
  assert.deepEqual([...runnable(declaration, state)], ["first-party"]);
});

// Half a grant is not half a vendor: the request either goes or it does not.
test("a vendor whose purposes are only partly granted does not run", () => {
  const state = grant(declaration, ["audience"], options);

  assert.equal(allowsVendor(declaration, state, "acme-analytics"), true);
  assert.equal(allowsVendor(declaration, state, "adnet"), false);
  assert.deepEqual([...runnable(declaration, state)], ["acme-analytics", "first-party"]);
});

// Withdrawal cannot be harder than consent if it is the same call.
test("granting and refusing take the same arguments in the same order", () => {
  assert.equal(grant.length, refuse.length);

  const granted = grant(declaration, ["audience", "retargeting"], options);
  const refused = refuse(declaration, ["audience", "retargeting"], options, granted);

  assert.deepEqual(granted.decision?.granted, ["necessary", "statistics", "marketing"]);
  assert.deepEqual(refused.decision?.granted, ["necessary"]);
  assert.equal(refused.decision?.method, "custom");
  assert.equal(refused.log.length, 2);
});

test("a grant adds to what was already granted", () => {
  let state = grant(declaration, ["audience"], options);
  state = grant(declaration, ["retargeting"], options, state);

  assert.deepEqual(state.decision?.granted, ["necessary", "statistics", "marketing"]);
});

test("a refusal leaves everything it did not name", () => {
  const state = refuse(declaration, ["retargeting"], options, acceptAll(options));

  assert.deepEqual(state.decision?.granted, ["necessary", "preferences", "statistics"]);
});

// Naming a necessary purpose in a refusal must not make the service unusable.
test("a necessary purpose survives being refused", () => {
  const state = refuse(declaration, ["session"], options, acceptAll(options));

  assert.equal(allowsPurpose(declaration, state, "session"), true);
  assert.deepEqual(state.decision?.granted, [
    "necessary",
    "preferences",
    "statistics",
    "marketing",
  ]);
});

test("after a withdrawal a grant starts from nothing rather than from the old answer", () => {
  const withdrawn = withdraw(options, acceptAll(options));
  const state = grant(declaration, ["audience"], options, withdrawn);

  assert.deepEqual(state.decision?.granted, ["necessary", "statistics"]);
});

// A mistyped id reads as a refusal one way and an empty grant the other, so it
// is neither.
test("an undeclared purpose is a mistake, not a quiet no", () => {
  assert.throws(() => allowsPurpose(declaration, unset(), "audiance"), InvalidDeclaration);
  assert.throws(() => grant(declaration, ["audiance"], options), InvalidDeclaration);
  assert.throws(() => refuse(declaration, ["audiance"], options), InvalidDeclaration);
  assert.throws(() => vendorsFor(declaration, "audiance"), InvalidDeclaration);
});

test("the declaration reads in both directions", () => {
  assert.deepEqual(
    vendorsFor(declaration, "audience").map((item) => item.id),
    ["acme-analytics", "adnet"],
  );
  assert.deepEqual(
    purposesOf(declaration, "adnet").map((item) => item.id),
    ["audience", "retargeting"],
  );
  assert.deepEqual(categoriesOf(declaration, ["retargeting", "session"]), [
    "necessary",
    "marketing",
  ]);
});

// The declaration is what the notice is about, so it can be what the notice is
// fingerprinted from.
test("the fingerprint follows the declaration, not the order it was written in", () => {
  const reordered = declare({
    purposes: [...declaration.purposes].reverse(),
    vendors: [...declaration.vendors].reverse(),
  });
  assert.match(declarationHash(declaration), /^[0-9a-f]{16}$/);
  assert.equal(declarationHash(reordered), declarationHash(declaration));

  const reworded = declare({
    purposes: [session, { ...audience, description: "Which pages are read, and by whom." }, retargeting],
    vendors: declaration.vendors,
  });
  assert.notEqual(declarationHash(reworded), declarationHash(declaration));

  const added = declare({
    purposes: declaration.purposes,
    vendors: [...declaration.vendors, { id: "extra", name: "Extra", purposes: ["audience"] }],
  });
  assert.notEqual(declarationHash(added), declarationHash(declaration));
});
