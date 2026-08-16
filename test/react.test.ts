/**
 * A real render of the hook, and the storage failure that a banner must
 * survive: if localStorage throws, the page still has to let people consent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useConsent, type Store } from "../src/index.ts";

const noticeVersion = "2026-08-01";

function memoryStore(): Store {
  let held: Parameters<Store["write"]>[0] = null;
  return {
    read: () => held,
    write: (decision) => {
      held = decision;
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

function Banner({ store }: { store: Store }) {
  const consent = useConsent({ noticeVersion, store });
  return createElement("div", {
    "data-pending": String(consent.pending),
    "data-marketing": String(consent.allows("marketing")),
    "data-necessary": String(consent.allows("necessary")),
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
  store.write({
    granted: ["necessary", "marketing"],
    at: "2026-08-16T10:00:00.000Z",
    noticeVersion,
    method: "custom",
  });

  const html = renderToStaticMarkup(createElement(Banner, { store }));
  assert.match(html, /data-pending="false"/);
  assert.match(html, /data-marketing="true"/);
});

// Losing the record is bad. Throwing inside the banner is worse: then nobody
// can consent at all.
test("a storage that throws does not take the banner down", () => {
  const html = renderToStaticMarkup(createElement(Banner, { store: brokenStore() }));
  assert.match(html, /data-pending="true"/);
});
