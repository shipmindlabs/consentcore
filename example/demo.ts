/**
 * A visitor arrives, scripts wait, a choice is made, and the notice changes.
 *
 *   npm run demo
 */

import { accept, acceptAll, allows, Gate, restore, unset, withdraw } from "../src/index.ts";

const options = { noticeVersion: "2026-08-01", now: () => new Date("2026-08-16T10:00:00Z") };
const ran: string[] = [];

console.log("visitor arrives, nothing decided");
let state = unset();
const gate = new Gate(state, options);
gate.when("necessary", "session cookie", () => ran.push("session cookie"));
gate.when("statistics", "analytics", () => ran.push("analytics"));
gate.when("marketing", "ad pixel", () => ran.push("ad pixel"));
console.log(`  ran     : ${ran.join(", ") || "nothing"}`);
console.log(`  waiting : ${gate.pending.join(", ")}`);
console.log(`  marketing allowed: ${allows(state, "marketing")}`);

console.log("\nvisitor accepts statistics only");
state = accept(["statistics"], options);
gate.update(state);
console.log(`  ran     : ${ran.join(", ")}`);
console.log(`  waiting : ${gate.pending.join(", ")}`);

console.log("\nvisitor withdraws");
state = withdraw(options);
console.log(`  notice shown again: ${state.pending}`);
console.log(`  statistics allowed: ${allows(state, "statistics")}`);

console.log("\nthe notice text changes to a new version");
const older = acceptAll(options).decision;
const carried = restore(older, { ...options, noticeVersion: "2026-09-01" });
console.log(`  old decision carried forward: ${carried.decision !== null}`);
console.log(`  asked again                 : ${carried.pending}`);

console.log("\nrecord of what ran");
for (const entry of gate.ran) {
  console.log(`  ${entry.at}  ${entry.category.padEnd(11)} ${entry.label}`);
}
