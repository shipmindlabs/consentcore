/**
 * The script gate. The tests that matter here are the ones where consent moves
 * after a tag is already on the page: the element has to leave, not be paused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accept,
  acceptAll,
  domHost,
  DuplicateTag,
  hashNotice,
  PURPOSE_ATTRIBUTE,
  restore,
  TAG_ATTRIBUTE,
  Tags,
  unset,
  withdraw,
  type Options,
  type TagDocument,
  type TagRoot,
} from "../src/index.ts";

const options: Options = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now: () => new Date("2026-08-16T10:00:00Z"),
};

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
    // The host only ever asks for one attribute, so this need not be a CSS engine.
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

// Opt-in means the vendor does not get the request until the visitor has said so.
test("a tag registered before any decision is held, not loaded", () => {
  const page = fakePage();
  const tags = new Tags(unset(), { host: page.host, now: options.now });
  tags.register({ id: "analytics", purpose: "statistics", src: "https://cdn.example/a.js" });

  assert.deepEqual([...tags.held], ["analytics"]);
  assert.deepEqual([...tags.live], []);
  assert.deepEqual(page.scripts, []);
});

test("a decision releases the purposes it granted and holds the rest", () => {
  const page = fakePage();
  const tags = new Tags(unset(), { host: page.host, now: options.now });
  tags.register({ id: "analytics", purpose: "statistics", src: "https://cdn.example/a.js" });
  tags.register({ id: "pixel", purpose: "marketing", src: "https://cdn.example/p.js" });

  tags.update(accept(["statistics"], options));

  assert.deepEqual([...tags.live], ["analytics"]);
  assert.deepEqual([...tags.held], ["pixel"]);
  assert.deepEqual(ids(page.scripts), ["analytics"]);
  assert.equal(page.scripts[0].getAttribute("src"), "https://cdn.example/a.js");
  assert.equal(page.scripts[0].getAttribute(PURPOSE_ATTRIBUTE), "statistics");
});

test("a necessary tag does not wait for an answer it is not owed", () => {
  const page = fakePage();
  const tags = new Tags(unset(), { host: page.host, now: options.now });
  tags.register({ id: "session", purpose: "necessary", src: "https://cdn.example/s.js" });

  assert.deepEqual([...tags.live], ["session"]);
  assert.deepEqual(ids(page.scripts), ["session"]);
});

// Leaving the element in place, inert, keeps a refused vendor one line away
// from running. Withdrawal means it leaves the page.
test("withdrawal removes the element rather than pausing it", () => {
  const cleaned: string[] = [];
  const page = fakePage();
  const decided = acceptAll(options);
  const tags = new Tags(decided, { host: page.host, now: options.now });

  tags.register({ id: "session", purpose: "necessary", src: "https://cdn.example/s.js" });
  tags.register({
    id: "analytics",
    purpose: "statistics",
    src: "https://cdn.example/a.js",
    cleanup: () => cleaned.push("analytics"),
  });
  assert.deepEqual(ids(page.scripts), ["session", "analytics"]);

  tags.update(withdraw(options, decided));

  assert.deepEqual(ids(page.scripts), ["session"]);
  assert.deepEqual([...tags.live], ["session"]);
  assert.deepEqual([...tags.held], ["analytics"]);
  assert.deepEqual(cleaned, ["analytics"]);
});

// A tag is not a one-shot effect: a new grant is a new answer, not a replay.
test("consenting again releases a tag that had been removed", () => {
  const page = fakePage();
  let state = acceptAll(options);
  const tags = new Tags(state, { host: page.host, now: options.now });
  tags.register({ id: "pixel", purpose: "marketing", src: "https://cdn.example/p.js" });

  state = withdraw(options, state);
  tags.update(state);
  assert.deepEqual(page.scripts, []);

  state = acceptAll(options, state);
  tags.update(state);

  assert.deepEqual(ids(page.scripts), ["pixel"]);
  assert.deepEqual(
    tags.history.map((event) => event.action),
    ["released", "revoked", "released"],
  );
});

// A new notice is a new question, so what the old answer released comes down.
test("an edited notice revokes what the superseded decision had released", () => {
  const page = fakePage();
  const decided = acceptAll(options);
  const tags = new Tags(decided, { host: page.host, now: options.now });
  tags.register({ id: "analytics", purpose: "statistics", src: "https://cdn.example/a.js" });

  const edited = { ...options, noticeHash: hashNotice("We use cookies, and we sell ads.") };
  tags.update(restore(decided.log, edited));

  assert.deepEqual(page.scripts, []);
  assert.deepEqual([...tags.held], ["analytics"]);
});

test("history says what was released and removed, and when", () => {
  const page = fakePage();
  const decided = acceptAll(options);
  const tags = new Tags(decided, { host: page.host, now: options.now });
  tags.register({ id: "analytics", purpose: "statistics", src: "https://cdn.example/a.js" });
  tags.update(withdraw(options, decided));

  assert.deepEqual(tags.history, [
    {
      id: "analytics",
      purpose: "statistics",
      action: "released",
      at: "2026-08-16T10:00:00.000Z",
    },
    {
      id: "analytics",
      purpose: "statistics",
      action: "revoked",
      at: "2026-08-16T10:00:00.000Z",
    },
  ]);
});

test("an inline snippet and extra attributes reach the element", () => {
  const page = fakePage();
  const tags = new Tags(acceptAll(options), { host: page.host, now: options.now });
  tags.register({
    id: "datalayer",
    purpose: "statistics",
    inline: "window.dataLayer = window.dataLayer || [];",
    attributes: { nonce: "abc123" },
  });

  const [script] = page.scripts;
  assert.equal(script.textContent, "window.dataLayer = window.dataLayer || [];");
  assert.equal(script.getAttribute("nonce"), "abc123");
  assert.equal(script.getAttribute(TAG_ATTRIBUTE), "datalayer");
});

// Two tags under one id would leave one of them untracked, which is the one
// that then survives a withdrawal.
test("the same id twice is refused rather than quietly replaced", () => {
  const page = fakePage();
  const tags = new Tags(unset(), { host: page.host, now: options.now });
  tags.register({ id: "pixel", purpose: "marketing", src: "https://cdn.example/p.js" });

  assert.throws(
    () => tags.register({ id: "pixel", purpose: "statistics", src: "https://cdn.example/q.js" }),
    DuplicateTag,
  );
});

test("unregistering removes a live tag and no later decision brings it back", () => {
  const page = fakePage();
  const tags = new Tags(acceptAll(options), { host: page.host, now: options.now });
  tags.register({ id: "pixel", purpose: "marketing", src: "https://cdn.example/p.js" });

  tags.unregister("pixel");
  assert.deepEqual(page.scripts, []);

  tags.update(acceptAll(options));
  assert.deepEqual([...tags.live], []);
  assert.deepEqual([...tags.held], []);
});

// Rendering on a server is ordinary, not an error the caller has to guard.
test("with no document there is nothing to mount, and nothing throws", () => {
  const tags = new Tags(acceptAll(options), { now: options.now });
  tags.register({ id: "pixel", purpose: "marketing", src: "https://cdn.example/p.js" });

  assert.deepEqual([...tags.live], ["pixel"]);
  tags.update(withdraw(options));
  assert.deepEqual([...tags.live], []);
});
