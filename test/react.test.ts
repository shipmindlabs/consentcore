/**
 * A real render of the hook: the states a banner can be in, what one action
 * does to each of them, and the storage failure a banner has to survive.
 *
 * The states are the ones a notice has to draw — undecided, accepted, rejected,
 * a partial choice — and the thing worth asserting about them is not the markup
 * but that leaving any of them costs the same whichever way the visitor goes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  hashNotice,
  useConsent,
  type Decision,
  type Store,
  type UseConsent,
} from "../src/index.ts";

const noticeVersion = "2026-08-01";
const noticeHash = hashNotice("We use cookies to run the site and to count visits.");
const editedHash = hashNotice("We use cookies to run the site, count visits and sell ads.");

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

type Mounted = { readonly html: string; readonly consent: UseConsent };

/**
 * One render, with the hook it produced.
 *
 * A static render never commits a state update, so a decision is read back the
 * way a reload reads it: out of the store the hook wrote it to. That is the
 * transition being tested, not an implementation detail of the renderer.
 */
function mount(store: Store, hash = noticeHash): Mounted {
  const rendered: UseConsent[] = [];

  function Banner() {
    const consent = useConsent({ noticeVersion, noticeHash: hash, store });
    rendered.push(consent);
    return createElement("div", {
      "data-pending": String(consent.pending),
      "data-method": String(consent.decision?.method ?? "none"),
      "data-necessary": String(consent.allows("necessary")),
      "data-preferences": String(consent.allows("preferences")),
      "data-statistics": String(consent.allows("statistics")),
      "data-marketing": String(consent.allows("marketing")),
      "data-logged": String(consent.log.length),
      "data-superseded": String(consent.superseded?.method ?? "none"),
    });
  }

  const html = renderToStaticMarkup(createElement(Banner));
  return { html, consent: rendered[rendered.length - 1] };
}

/** Take one action from wherever the store is, and look at what followed. */
function after(
  store: Store,
  action: (consent: UseConsent) => void,
  hash = noticeHash,
): Mounted {
  action(mount(store, hash).consent);
  return mount(store, hash);
}

const accepted = (): Store => {
  const store = memoryStore();
  after(store, (consent) => consent.acceptAll());
  return store;
};

const rejected = (): Store => {
  const store = memoryStore();
  after(store, (consent) => consent.rejectAll());
  return store;
};

const partial = (): Store => {
  const store = memoryStore();
  after(store, (consent) => consent.accept(["statistics"]));
  return store;
};

const withdrawn = (): Store => {
  const store = accepted();
  after(store, (consent) => consent.withdraw());
  return store;
};

test("a fresh visitor sees the notice and has consented to nothing", () => {
  const { html } = mount(memoryStore());

  assert.match(html, /data-pending="true"/);
  assert.match(html, /data-method="none"/);
  assert.match(html, /data-marketing="false"/);
  assert.match(html, /data-statistics="false"/);
  assert.match(html, /data-necessary="true"/);
  assert.match(html, /data-logged="0"/);
});

test("undecided to accepted: one action grants every category", () => {
  const { html, consent } = after(memoryStore(), (banner) => banner.acceptAll());

  assert.match(html, /data-pending="false"/);
  assert.match(html, /data-method="accept-all"/);
  assert.match(html, /data-marketing="true"/);
  assert.equal(consent.log.length, 1);
  assert.deepEqual(consent.decision?.granted, [
    "necessary",
    "preferences",
    "statistics",
    "marketing",
  ]);
});

// A refusal is a decision, not an absence of one: the notice comes down and the
// record says what was answered.
test("undecided to rejected: one action records the refusal and keeps necessary", () => {
  const { html, consent } = after(memoryStore(), (banner) => banner.rejectAll());

  assert.match(html, /data-pending="false"/);
  assert.match(html, /data-method="reject-all"/);
  assert.match(html, /data-necessary="true"/);
  assert.match(html, /data-statistics="false"/);
  assert.match(html, /data-marketing="false"/);
  assert.equal(consent.log.length, 1);
  assert.deepEqual(consent.decision?.granted, ["necessary"]);
});

test("undecided to partial: exactly what was named, and nothing beside it", () => {
  const { html, consent } = after(memoryStore(), (banner) => banner.accept(["statistics"]));

  assert.match(html, /data-pending="false"/);
  assert.match(html, /data-method="custom"/);
  assert.match(html, /data-statistics="true"/);
  assert.match(html, /data-preferences="false"/);
  assert.match(html, /data-marketing="false"/);
  assert.deepEqual(consent.decision?.granted, ["necessary", "statistics"]);
});

// Withdrawal has to leave a way back, so it returns to the state the visitor
// started in rather than to one with no banner and no permissions.
test("accepted to undecided: withdrawing revokes everything and puts the notice back", () => {
  const store = accepted();
  const { html, consent } = after(store, (banner) => banner.withdraw());

  assert.match(html, /data-pending="true"/);
  assert.match(html, /data-method="withdrawn"/);
  assert.match(html, /data-marketing="false"/);
  assert.equal(consent.log.length, 2);

  const again = after(store, (banner) => banner.acceptAll());
  assert.match(again.html, /data-pending="false"/);
  assert.match(again.html, /data-marketing="true"/);
});

// "As easy to withdraw as to give" is a property of the API before it is a
// property of the button. If refusing took an extra call, an extra argument or
// an extra state to pass through, no amount of styling would get it back.
test("reject-all is one action from every state accept-all is one action from", () => {
  const situations: readonly { name: string; store: () => Store; hash?: string }[] = [
    { name: "undecided", store: memoryStore },
    { name: "accepted", store: accepted },
    { name: "rejected", store: rejected },
    { name: "partial", store: partial },
    { name: "withdrawn", store: withdrawn },
    { name: "an edited notice", store: accepted, hash: editedHash },
  ];

  for (const { name, store, hash } of situations) {
    const giving = store();
    const refusing = store();
    const before = mount(giving, hash).consent;

    assert.equal(typeof before.acceptAll, "function", name);
    assert.equal(typeof before.rejectAll, "function", name);
    assert.equal(before.rejectAll.length, before.acceptAll.length, name);

    const granted = after(giving, (banner) => banner.acceptAll(), hash).consent;
    const refused = after(refusing, (banner) => banner.rejectAll(), hash).consent;

    assert.equal(granted.pending, false, name);
    assert.equal(refused.pending, false, name);
    assert.equal(granted.decision?.method, "accept-all", name);
    assert.equal(refused.decision?.method, "reject-all", name);
    assert.equal(granted.log.length, before.log.length + 1, name);
    assert.equal(refused.log.length, granted.log.length, name);
    assert.deepEqual(refused.decision?.granted, ["necessary"], name);
    assert.equal(granted.allows("marketing"), true, name);
    assert.equal(refused.allows("marketing"), false, name);
  }
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

  const { html } = mount(store);
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

  const { html } = mount(store, editedHash);
  assert.match(html, /data-pending="true"/);
  assert.match(html, /data-marketing="false"/);
  assert.match(html, /data-logged="1"/);
  assert.match(html, /data-superseded="custom"/);
});

// Losing the record is bad. Throwing inside the banner is worse: then nobody
// can consent at all.
test("a storage that throws does not take the banner down", () => {
  const { html } = mount(brokenStore());
  assert.match(html, /data-pending="true"/);
});
