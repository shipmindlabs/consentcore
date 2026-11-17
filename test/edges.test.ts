/**
 * Edge cases and failure modes of the parts added most recently: the
 * declaration, tags gated on a declared vendor, and the thirteen-month window
 * now that it is a rule about the decision rather than about the store.
 *
 * The ordinary paths live beside the code they exercise, in consent.test.ts,
 * registry.test.ts and tags.test.ts; what is here is the awkward input.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accept,
  acceptAll,
  allows,
  allowsPurpose,
  allowsVendor,
  categoriesOf,
  declarationHash,
  declare,
  domHost,
  expired,
  expiresAt,
  grant,
  hashNotice,
  InvalidDeclaration,
  purposesOf,
  refuse,
  restore,
  runnable,
  superseded,
  TAG_ATTRIBUTE,
  Tags,
  unset,
  withdraw,
  type Decision,
  type Options,
  type Purpose,
  type TagDocument,
  type TagRoot,
  type Vendor,
} from "../src/index.ts";

const options: Options = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now: () => new Date("2026-08-16T10:00:00Z"),
};

/** A record as it comes back from storage, rather than one this code just made. */
const decisionAt = (at: string): Decision => ({
  granted: ["necessary", "statistics"],
  at,
  noticeVersion: options.noticeVersion,
  noticeHash: options.noticeHash ?? "",
  method: "custom",
});

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
    { id: "acme-analytics", name: "Acme Analytics", purposes: ["audience"] },
    { id: "adnet", name: "AdNet", purposes: ["audience", "retargeting"] },
    { id: "first-party", name: "This site", purposes: ["session"] },
  ],
});

/** Enough of a page to tell whether a script is on it. */
class FakeScript {
  textContent: string | null = null;
  readonly #attributes = new Map<string, string>();
  readonly #page: FakeScript[];

  constructor(page: FakeScript[]) {
    this.#page = page;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  remove(): void {
    const at = this.#page.indexOf(this);
    if (at >= 0) this.#page.splice(at, 1);
  }
}

function fakePage() {
  const scripts: FakeScript[] = [];
  const root: TagRoot = {
    append(node) {
      scripts.push(node as FakeScript);
    },
    querySelectorAll: (selector) =>
      scripts.filter((script) => script.getAttribute(selector.slice(1, -1)) !== null),
  };
  const document: TagDocument = {
    createElement: () => new FakeScript(scripts),
    head: root,
  };
  return { scripts, host: domHost({ document }) };
}

const ids = (scripts: FakeScript[]) => scripts.map((script) => script.getAttribute(TAG_ATTRIBUTE));

// What reaches the record is a set of categories, so neither the order a banner
// collected them in nor a box counted twice can show up in it.
test("repeated and out-of-order categories are recorded once, in category order", () => {
  const state = accept(["marketing", "statistics", "marketing"], options);

  assert.deepEqual(state.decision?.granted, ["necessary", "statistics", "marketing"]);
});

// Accepting nothing optional is an answer. Treating it as no answer would put
// the notice back on the next page view, which is not remembering a refusal.
test("accepting nothing records a decision rather than leaving the notice due", () => {
  const state = accept([], options);

  assert.equal(state.pending, false);
  assert.equal(state.decision?.method, "custom");
  assert.deepEqual(state.decision?.granted, ["necessary"]);
});

// Dropping the fingerprint is itself a change to the question, so it is not a
// way to carry an answer past an edit.
test("an answer given against a fingerprinted notice is not restored without it", () => {
  const restored = restore(acceptAll(options).log, {
    noticeVersion: options.noticeVersion,
    now: options.now,
  });

  assert.equal(restored.pending, true);
  assert.equal(restored.decision, null);
});

test("a notice nobody fingerprinted still restores against the same options", () => {
  const plain: Options = { noticeVersion: "2026-08-01", now: options.now };
  const before = acceptAll(plain);

  assert.equal(before.decision?.noticeHash, "");
  assert.equal(restore(before.log, plain).pending, false);
  assert.equal(allows(restore(before.log, plain), "marketing"), true);
});

// Thirteen months after a day the target month does not have would otherwise
// roll into the month after, which is the longer window of the two.
test("a window landing on a day that does not exist ends on the last one", () => {
  assert.equal(expiresAt(decisionAt("2026-03-31T12:00:00.000Z")), "2027-04-30T12:00:00.000Z");
  assert.equal(expiresAt(decisionAt("2026-01-29T00:00:00.000Z")), "2027-02-28T00:00:00.000Z");
});

// Consent that cannot be dated cannot be shown to be inside the window, and the
// record exists to be shown.
test("a record whose timestamp cannot be read is not an answer", () => {
  const unreadable = decisionAt("last Tuesday");
  const state = restore([unreadable], options);

  assert.equal(expired(unreadable), true);
  assert.equal(state.pending, true);
  assert.equal(state.decision, null);
  assert.equal(allows(state, "statistics"), false);
});

// `necessary` is not a choice, so it does not depend on a stored list naming it.
test("necessary is allowed even by a record that does not list it", () => {
  const odd = { ...decisionAt("2026-08-16T10:00:00.000Z"), granted: ["marketing"] as const };
  const state = restore([odd], options);

  assert.equal(allows(state, "necessary"), true);
  assert.equal(allows(state, "marketing"), true);
  assert.equal(allows(state, "statistics"), false);
});

// A withdrawal is the current answer, not one that something replaced, so a
// banner asking what changed is told nothing did.
test("a withdrawal is pending without being superseded", () => {
  const restored = restore(withdraw(options, acceptAll(options)).log, options);

  assert.equal(restored.pending, true);
  assert.equal(restored.decision?.method, "withdrawn");
  assert.equal(superseded(restored), null);
});

// What `declare` checked has to be what it hands back, or the check was of a
// declaration nobody is using.
test("editing the arrays afterwards does not edit the declaration", () => {
  const purposes: Purpose[] = [audience];
  const vendors: Vendor[] = [{ id: "adnet", name: "AdNet", purposes: ["audience"] }];
  const checked = declare({ purposes, vendors });

  purposes.push(retargeting);
  vendors.push({ id: "extra", name: "Extra", purposes: ["retargeting"] });

  assert.deepEqual(
    checked.purposes.map((item) => item.id),
    ["audience"],
  );
  assert.deepEqual(
    checked.vendors.map((item) => item.id),
    ["adnet"],
  );
});

// An empty id is a line of the declaration no notice can refer to and no caller
// can ask about.
test("an entry with no id, and a vendor with no name, are refused", () => {
  assert.throws(
    () => declare({ purposes: [{ ...audience, id: "" }], vendors: [] }),
    InvalidDeclaration,
  );
  assert.throws(
    () =>
      declare({
        purposes: [audience],
        vendors: [{ id: "", name: "AdNet", purposes: ["audience"] }],
      }),
    InvalidDeclaration,
  );
  assert.throws(
    () =>
      declare({
        purposes: [audience],
        vendors: [{ id: "adnet", name: "", purposes: ["audience"] }],
      }),
    InvalidDeclaration,
  );
});

test("a declaration with nothing in it is valid, and permits nobody", () => {
  const empty = declare({ purposes: [], vendors: [] });

  assert.deepEqual([...runnable(empty, acceptAll(options))], []);
  assert.deepEqual(categoriesOf(empty, []), []);
});

test("an undeclared vendor is a mistake wherever it is asked about", () => {
  assert.throws(() => allowsVendor(declaration, unset(), "adnetwork"), InvalidDeclaration);
  assert.throws(() => purposesOf(declaration, "adnetwork"), InvalidDeclaration);
});

// A refusal is a decision, so it is remembered rather than asked again on the
// next page view — including the first one, made from no previous state at all.
test("refusing before anything was decided is itself an answer", () => {
  const state = refuse(declaration, ["audience"], options);

  assert.equal(state.pending, false);
  assert.equal(state.decision?.method, "custom");
  assert.deepEqual(state.decision?.granted, ["necessary"]);
  assert.equal(state.log.length, 1);
});

test("granting and refusing nothing are answers that change nothing else", () => {
  assert.deepEqual(grant(declaration, [], options).decision?.granted, ["necessary"]);

  const everything = acceptAll(options);
  const after = refuse(declaration, [], options, everything);

  assert.deepEqual(after.decision?.granted, everything.decision?.granted);
  assert.equal(after.log.length, 2);
});

test("the order purposes are named in does not reach the record", () => {
  const forwards = grant(declaration, ["audience", "retargeting"], options);
  const backwards = grant(declaration, ["retargeting", "audience"], options);

  assert.deepEqual(forwards.decision?.granted, backwards.decision?.granted);
  assert.deepEqual(grant(declaration, ["audience", "audience"], options).decision?.granted, [
    "necessary",
    "statistics",
  ]);
});

// A purpose is answered through its category, so two purposes filed under one
// are a single answer — which is why purposes needing separate answers need
// separate categories.
test("purposes sharing a category are granted and refused together", () => {
  const detailed = declare({
    purposes: [
      audience,
      {
        id: "heatmaps",
        category: "statistics",
        name: "Where people click",
        description: "A record of clicks and scrolling on a page, in aggregate.",
      },
    ],
    vendors: [
      { id: "acme-analytics", name: "Acme Analytics", purposes: ["audience"] },
      { id: "hotmaps", name: "Hotmaps", purposes: ["heatmaps"] },
    ],
  });

  const granted = grant(detailed, ["audience"], options);
  assert.equal(allowsPurpose(detailed, granted, "heatmaps"), true);
  assert.deepEqual([...runnable(detailed, granted)], ["acme-analytics", "hotmaps"]);

  const refused = refuse(detailed, ["heatmaps"], options, granted);
  assert.equal(allowsPurpose(detailed, refused, "audience"), false);
  assert.deepEqual([...runnable(detailed, refused)], []);
});

test("after a withdrawal only vendors on necessary purposes may still run", () => {
  const withdrawn = withdraw(options, acceptAll(options));

  assert.deepEqual([...runnable(declaration, withdrawn)], ["first-party"]);
  assert.equal(allowsVendor(declaration, withdrawn, "acme-analytics"), false);
});

// What a vendor sets and where it sends the data is part of what the visitor was
// told, so it is part of what they answered.
test("the fingerprint follows a vendor's cookies, policy and transfers", () => {
  const base = { id: "adnet", name: "AdNet", purposes: ["audience"] };
  const written = declare({ purposes: [audience], vendors: [{ ...base, cookies: ["_a", "_b"] }] });
  const reordered = declare({
    purposes: [audience],
    vendors: [{ ...base, cookies: ["_b", "_a"] }],
  });
  const sentAbroad = declare({
    purposes: [audience],
    vendors: [{ ...base, cookies: ["_a", "_b"], transfers: "US" }],
  });
  const published = declare({
    purposes: [audience],
    vendors: [{ ...base, cookies: ["_a", "_b"], policy: "https://adnet.example/privacy" }],
  });

  assert.equal(declarationHash(reordered), declarationHash(written));
  assert.notEqual(declarationHash(sentAbroad), declarationHash(written));
  assert.notEqual(declarationHash(published), declarationHash(written));
});

// Every field in the fingerprint comes from a caller, so no field may
// impersonate two.
test("a declared field cannot be shifted into its neighbour", () => {
  const honest = declare({
    purposes: [{ id: "audience", category: "statistics", name: "Counting", description: "visits" }],
    vendors: [],
  });
  const smuggled = declare({
    purposes: [
      { id: "audience", category: "statistics", name: 'Counting","vis', description: "its" },
    ],
    vendors: [],
  });

  assert.notEqual(declarationHash(smuggled), declarationHash(honest));
});

// A decision does not arrive once: a render, a restore and a message from
// another tab can all carry the same answer, and a tag already on the page must
// not be mounted beside itself.
test("the same answer arriving again releases nothing new", () => {
  const page = fakePage();
  const tags = new Tags(unset(), { host: page.host, now: options.now });
  tags.register({ id: "analytics", purpose: "statistics", src: "https://cdn.example/a.js" });

  const decided = accept(["statistics"], options);
  tags.update(decided);
  tags.update(decided);
  tags.update(restore(decided.log, options));

  assert.deepEqual(ids(page.scripts), ["analytics"]);
  assert.deepEqual(
    tags.history.map((event) => event.action),
    ["released"],
  );
});

// Held is not the same as revoked: a tag that was never on the page has nothing
// to report, and nothing to clean up.
test("a decision that does not release a held tag is not an event", () => {
  const page = fakePage();
  const cleaned: string[] = [];
  const tags = new Tags(unset(), { host: page.host, now: options.now });
  tags.register({
    id: "pixel",
    purpose: "marketing",
    src: "https://cdn.example/p.js",
    cleanup: () => cleaned.push("pixel"),
  });

  tags.update(accept(["statistics"], options));
  tags.update(withdraw(options));
  tags.unregister("pixel");

  assert.deepEqual(tags.history, []);
  assert.deepEqual(cleaned, []);
});

// Taking an element off the page does not undo what it already did, whichever
// way it left.
test("unregistering a live tag runs its cleanup, and frees the id", () => {
  const cleaned: string[] = [];
  const page = fakePage();
  const tags = new Tags(acceptAll(options), { host: page.host, now: options.now });
  tags.register({
    id: "pixel",
    purpose: "marketing",
    src: "https://cdn.example/p.js",
    cleanup: () => cleaned.push("pixel"),
  });

  tags.unregister("pixel");
  tags.register({ id: "pixel", purpose: "marketing", src: "https://cdn.example/q.js" });

  assert.deepEqual(cleaned, ["pixel"]);
  assert.deepEqual([...tags.live], ["pixel"]);
  assert.deepEqual(ids(page.scripts), ["pixel"]);
  assert.equal(page.scripts[0].getAttribute("src"), "https://cdn.example/q.js");
});

test("unregistering a tag nobody registered is not an error", () => {
  const tags = new Tags(unset(), { now: options.now });

  assert.doesNotThrow(() => tags.unregister("nothing"));
  assert.deepEqual(tags.history, []);
});

test("tags gated on a category and on a vendor are held side by side", () => {
  const page = fakePage();
  const tags = new Tags(unset(), { host: page.host, now: options.now, declaration });
  tags.register({ id: "stats", purpose: "statistics", src: "https://cdn.example/s.js" });
  tags.register({ id: "ads", vendor: "adnet", src: "https://cdn.example/ad.js" });

  tags.update(accept(["statistics"], options));

  assert.deepEqual([...tags.live], ["stats"]);
  assert.deepEqual([...tags.held], ["ads"]);
});

// A vendor that only processes for necessary purposes is not waiting on an
// answer, so a new question does not take it off the page.
test("an edited notice leaves a necessary vendor's tag where it is", () => {
  const page = fakePage();
  const decided = acceptAll(options);
  const tags = new Tags(decided, { host: page.host, now: options.now, declaration });
  tags.register({ id: "site", vendor: "first-party", src: "https://cdn.example/s.js" });
  tags.register({ id: "ads", vendor: "adnet", src: "https://cdn.example/ad.js" });

  const edited = { ...options, noticeHash: hashNotice("We use cookies, and we sell ads.") };
  tags.update(restore(decided.log, edited));

  assert.deepEqual(ids(page.scripts), ["site"]);
  assert.deepEqual([...tags.held], ["ads"]);
});
