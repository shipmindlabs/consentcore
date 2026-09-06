/**
 * A real render of the hook, and the storage failure that a banner must
 * survive: if localStorage throws, the page still has to let people consent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { hashNotice, useConsent, type Decision, type Store } from "../src/index.ts";

const noticeVersion = "2026-08-01";
const noticeHash = hashNotice("We use cookies to run the site and to count visits.");

function memoryStore(): Store {
  let held: readonly Decision[] = [];
  return {
    read: () => held,
    write: (log) => {
      held = log;
    },
  };
}

/** A store that fails every way a real one can. */
function brokenStore(): Store {
  return {
    read: () => null,
    write: () => {
      throw new Error("quota exceeded");
    },
  };
}

function Banner({ store, hash = noticeHash }: { store: Store; hash?: string }) {
  const consent = useConsent({ noticeVersion, noticeHash: hash, store });
  return createElement("div", {
    "data-pending": String(consent.pending),
    "data-marketing": String(consent.allows("marketing")),
    "data-necessary": String(consent.allows("necessary")),
    "data-logged": String(consent.log.length),
    "data-superseded": String(consent.superseded?.method ?? "none"),
  });
}

test("a fresh visitor sees the notice and has consented to nothing", () => {
  const html = renderToStaticMarkup(createElement(Banner, { store: memoryStore() }));
  assert.match(html, /data-pending="true"/);
  assert.match(html, /data-marketing="false"/);
  assert.match(html, /data-necessary="true"/);
});

test("a stored decision is restored on the first render", () => {
  const store = memoryStore();
  store.write([
    {
      granted: ["necessary", "marketing"],
      at: "2026-08-16T10:00:00.000Z",
      noticeVersion,
      noticeHash,
      method: "custom",
    },
  ]);

  const html = renderToStaticMarkup(createElement(Banner, { store }));
  assert.match(html, /data-pending="false"/);
  assert.match(html, /data-marketing="true"/);
});

// A new notice is a new question, and the old answer stays on the record
// rather than being carried over or quietly deleted.
test("an edited notice asks again and keeps the previous decision", () => {
  const store = memoryStore();
  store.write([
    {
      granted: ["necessary", "marketing"],
      at: "2026-08-16T10:00:00.000Z",
      noticeVersion,
      noticeHash,
      method: "custom",
    },
  ]);

  const hash = hashNotice("We use cookies to run the site, count visits and sell ads.");
  const html = renderToStaticMarkup(createElement(Banner, { store, hash }));
  assert.match(html, /data-pending="true"/);
  assert.match(html, /data-marketing="false"/);
  assert.match(html, /data-logged="1"/);
  assert.match(html, /data-superseded="custom"/);
});

// Losing the record is bad. Throwing inside the banner is worse: then nobody
// can consent at all.
test("a storage that throws does not take the banner down", () => {
  const html = renderToStaticMarkup(createElement(Banner, { store: brokenStore() }));
  assert.match(html, /data-pending="true"/);
});
