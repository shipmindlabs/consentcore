import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accept,
  acceptAll,
  allows,
  asLog,
  Gate,
  hashNotice,
  InvalidDecision,
  rejectAll,
  restore,
  superseded,
  unset,
  withdraw,
  type Options,
} from "../src/index.ts";

const options: Options = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now: () => new Date("2026-08-16T10:00:00Z"),
};

// Opt-in means opt-in. Code that treats "not answered yet" as permission is the
// violation these banners exist to avoid.
test("before any decision, only necessary is allowed", () => {
  const state = unset();
  assert.equal(state.pending, true);
  assert.equal(allows(state, "necessary"), true);
  for (const category of ["preferences", "statistics", "marketing"] as const) {
    assert.equal(allows(state, category), false, category);
  }
});

test("accepting everything grants every category and stops the notice", () => {
  const state = acceptAll(options);
  assert.equal(state.pending, false);
  assert.equal(state.decision?.method, "accept-all");
  assert.equal(state.decision?.at, "2026-08-16T10:00:00.000Z");
  assert.equal(allows(state, "marketing"), true);
});

test("rejecting everything still allows what the service cannot work without", () => {
  const state = rejectAll(options);
  assert.equal(state.pending, false);
  assert.deepEqual(state.decision?.granted, ["necessary"]);
  assert.equal(allows(state, "necessary"), true);
  assert.equal(allows(state, "statistics"), false);
});

test("a specific choice grants exactly that, plus necessary", () => {
  const state = accept(["statistics"], options);
  assert.deepEqual(state.decision?.granted, ["necessary", "statistics"]);
  assert.equal(allows(state, "statistics"), true);
  assert.equal(allows(state, "marketing"), false);
  assert.equal(state.decision?.method, "custom");
});

test("a category that does not exist is refused rather than ignored", () => {
  assert.throws(() => accept(["analytics" as never], options), InvalidDecision);
});

// Withdrawal must be as easy as consent, and it has to leave a way back.
test("withdrawing revokes everything and puts the notice back", () => {
  const after = withdraw(options);
  assert.equal(after.pending, true);
  assert.equal(after.decision?.method, "withdrawn");
  assert.equal(allows(after, "statistics"), false);
});

test("a decision records the notice it answered, version and text", () => {
  const decision = acceptAll(options).decision;
  assert.equal(decision?.noticeVersion, "2026-08-01");
  assert.equal(decision?.noticeHash, options.noticeHash);
});

test("the fingerprint is stable for the same text and moves for an edit", () => {
  assert.equal(hashNotice("same words"), hashNotice("same words"));
  assert.notEqual(hashNotice("same words"), hashNotice("same words."));
  assert.match(hashNotice(""), /^[0-9a-f]{16}$/);
});

// The visitor agreed to what that version of the notice said. A new version is
// a new question.
test("a decision against an older notice version is not carried forward", () => {
  const old = acceptAll({ ...options, noticeVersion: "2025-01-01" });
  const restored = restore(old.log, options);

  assert.equal(restored.pending, true);
  assert.equal(restored.decision, null);
  assert.equal(allows(restored, "marketing"), false);
});

// The version string is a promise someone has to remember to keep. The hash is
// checkable, and it catches the edit that forgot.
test("an edit to the notice text asks again even under the same version", () => {
  const before = acceptAll(options);
  const edited = { ...options, noticeHash: hashNotice("We use cookies, and we sell ads.") };
  const restored = restore(before.log, edited);

  assert.equal(restored.pending, true);
  assert.equal(restored.decision, null);
  assert.equal(allows(restored, "statistics"), false);
});

// Superseding an answer must not delete it: the log is the demonstrable part.
test("a superseded decision stays in the log", () => {
  const before = accept(["statistics"], options);
  const restored = restore(before.log, { ...options, noticeVersion: "2026-09-01" });

  assert.deepEqual(restored.log, before.log);
  assert.equal(superseded(restored)?.method, "custom");
  assert.equal(superseded(restored)?.noticeVersion, "2026-08-01");
});

test("a decision answering the current notice is not superseded", () => {
  assert.equal(superseded(acceptAll(options)), null);
  assert.equal(superseded(unset()), null);
});

test("decisions accumulate in the log, oldest first", () => {
  let state = accept(["statistics"], options);
  state = acceptAll(options, state);
  state = withdraw(options, state);

  assert.deepEqual(
    state.log.map((entry) => entry.method),
    ["custom", "accept-all", "withdrawn"],
  );
});

test("a decision against the current notice is restored", () => {
  const restored = restore(acceptAll(options).log, options);
  assert.equal(restored.pending, false);
  assert.equal(allows(restored, "marketing"), true);
});

// Records written before the log existed held a single decision.
test("a lone stored decision restores as a log of one", () => {
  const restored = restore(acceptAll(options).decision, options);
  assert.equal(restored.pending, false);
  assert.equal(restored.log.length, 1);
  assert.deepEqual(asLog(null), []);
});

test("a restored withdrawal asks again", () => {
  const restored = restore(withdraw(options).log, options);
  assert.equal(restored.pending, true);
  assert.equal(allows(restored, "statistics"), false);
});

// The bug this gate replaces: an analytics snippet that loads on page one, and
// a banner that appears a moment later.
test("work waits for its category and then runs in order", () => {
  const ran: string[] = [];
  const gate = new Gate(unset(), { now: options.now });

  gate.when("statistics", "analytics", () => ran.push("analytics"));
  gate.when("marketing", "pixel", () => ran.push("pixel"));
  gate.when("necessary", "session", () => ran.push("session"));

  // Necessary ran at once; the rest are held.
  assert.deepEqual(ran, ["session"]);
  assert.deepEqual([...gate.pending], ["analytics", "pixel"]);

  gate.update(accept(["statistics"], options));
  assert.deepEqual(ran, ["session", "analytics"]);
  assert.deepEqual([...gate.pending], ["pixel"]);

  gate.update(acceptAll(options));
  assert.deepEqual(ran, ["session", "analytics", "pixel"]);
  assert.deepEqual([...gate.pending], []);
});

test("nothing runs twice, however many decisions arrive", () => {
  const ran: string[] = [];
  const gate = new Gate(unset(), { now: options.now });
  gate.when("statistics", "analytics", () => ran.push("analytics"));

  gate.update(acceptAll(options));
  gate.update(acceptAll(options));
  gate.update(accept(["statistics"], options));

  assert.deepEqual(ran, ["analytics"]);
});

// Holding work in case the visitor changes their mind is how a queue becomes a
// loophole.
test("work whose category was withdrawn is dropped, not kept waiting", () => {
  const ran: string[] = [];
  const gate = new Gate(unset(), { now: options.now });
  gate.when("marketing", "pixel", () => ran.push("pixel"));

  gate.forget("marketing");
  gate.update(acceptAll(options));

  assert.deepEqual(ran, []);
  assert.deepEqual([...gate.pending], []);
});

test("the gate records what ran and under which category", () => {
  const gate = new Gate(acceptAll(options), { now: options.now });
  gate.when("statistics", "analytics", () => {});

  assert.equal(gate.ran.length, 1);
  assert.deepEqual(gate.ran[0], {
    label: "analytics",
    category: "statistics",
    at: "2026-08-16T10:00:00.000Z",
  });
});

test("work registered after consent runs immediately, not on the next tick", () => {
  let ran = false;
  new Gate(acceptAll(options)).when("marketing", "pixel", () => {
    ran = true;
  });
  assert.equal(ran, true, "a caller must be able to rely on ordering");
});
