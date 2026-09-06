/**
 * A visitor arrives, scripts wait, a choice is made, and the notice changes.
 *
 *   npm run demo
 */

import {
  accept,
  allows,
  Gate,
  hashNotice,
  restore,
  superseded,
  unset,
  withdraw,
} from "../src/index.ts";

const now = () => new Date("2026-08-16T10:00:00Z");
const august = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now,
};
const ran: string[] = [];

console.log("visitor arrives, nothing decided");
let state = unset();
const gate = new Gate(state, { now });
gate.when("necessary", "session cookie", () => ran.push("session cookie"));
gate.when("statistics", "analytics", () => ran.push("analytics"));
gate.when("marketing", "ad pixel", () => ran.push("ad pixel"));
console.log(`  ran     : ${ran.join(", ") || "nothing"}`);
console.log(`  waiting : ${gate.pending.join(", ")}`);
console.log(`  marketing allowed: ${allows(state, "marketing")}`);

console.log("\nvisitor accepts statistics only");
state = accept(["statistics"], august, state);
gate.update(state);
console.log(`  ran     : ${ran.join(", ")}`);
console.log(`  waiting : ${gate.pending.join(", ")}`);

console.log("\nthe notice text is edited; the version string is not");
const edited = {
  ...august,
  noticeHash: hashNotice("We use cookies to run the site, count visits and sell ads."),
};
state = restore(state.log, edited);
const previous = superseded(state);
console.log(`  old decision carried forward: ${state.decision !== null}`);
console.log(`  asked again                 : ${state.pending}`);
console.log(`  kept in the log             : ${previous?.method} at ${previous?.at}`);

console.log("\nvisitor withdraws");
state = withdraw(edited, state);
console.log(`  notice shown again : ${state.pending}`);
console.log(`  statistics allowed : ${allows(state, "statistics")}`);
console.log(`  decisions on record: ${state.log.length}`);

console.log("\nrecord of what ran");
for (const entry of gate.ran) {
  console.log(`  ${entry.at}  ${entry.category.padEnd(11)} ${entry.label}`);
}
