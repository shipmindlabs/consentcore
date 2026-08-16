import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accept,
  acceptAll,
  allows,
  Gate,
  InvalidDecision,
  rejectAll,
  restore,
  unset,
  withdraw,
  type Options,
} from "../src/index.ts";

const options: Options = { noticeVersion: "2026-08-01", now: () => new Date("2026-08-16T10:00:00Z") };

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

// The visitor agreed to what that version of the notice said. A new version is
// a new question.
test("a decision against an older notice is not carried forward", () => {
  const old = acceptAll({ ...options, noticeVersion: "2025-01-01" });
  const restored = restore(old.decision, options);

  assert.equal(restored.pending, true);
  assert.equal(restored.decision, null);
  assert.equal(allows(restored, "marketing"), false);
});

test("a decision against the current notice is restored", () => {
  const restored = restore(acceptAll(options).decision, options);
  assert.equal(restored.pending, false);
  assert.equal(allows(restored, "marketing"), true);
});

test("a restored withdrawal asks again", () => {
  const restored = restore(withdraw(options).decision, options);
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
