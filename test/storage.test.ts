/**
 * Where the record is kept. What matters here is time passing and a second tab:
 * an answer that has expired is not an answer, and a withdrawal in one tab is a
 * withdrawal in all of them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acceptAll,
  asLog,
  CONSENT_MONTHS,
  cookieStore,
  expired,
  expiresAt,
  hashNotice,
  localStore,
  restore,
  storageChannel,
  withdraw,
  type Channel,
  type Decision,
  type Options,
  type StorageEvent,
  type StorageEventTarget,
  type StorageLike,
} from "../src/index.ts";

const options: Options = {
  noticeVersion: "2026-08-01",
  noticeHash: hashNotice("We use cookies to run the site and to count visits."),
  now: () => new Date("2026-08-16T10:00:00Z"),
};

const decisionAt = (iso: string): Decision => ({
  granted: ["necessary", "statistics"],
  at: iso,
  noticeVersion: options.noticeVersion,
  noticeHash: options.noticeHash ?? "",
  method: "custom",
});

type Listener = (event: StorageEvent) => void;

/** Two tabs on one origin: a write reaches the others and never the writer. */
function fakeBrowser() {
  const values = new Map<string, string>();
  const tabs: Set<Listener>[] = [];

  const tab = () => {
    const listeners = new Set<Listener>();
    tabs.push(listeners);

    const announce = (key: string) => {
      for (const other of tabs) {
        if (other === listeners) continue;
        for (const listener of [...other]) listener({ key });
      }
    };

    const storage: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        const before = values.get(key);
        values.set(key, value);
        if (before !== value) announce(key);
      },
      removeItem: (key) => {
        if (values.delete(key)) announce(key);
      },
    };

    const events: StorageEventTarget = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    };

    return { storage, events };
  };

  return { tab };
}

/** Enough of `document.cookie` to tell what was set, and with what. */
function fakeJar() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    get cookie(): string {
      return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(written: string) {
      writes.push(written);
      const [pair, ...attributes] = written.split(";").map((part) => part.trim());
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals);
      const maxAge = attributes.find((part) => part.toLowerCase().startsWith("max-age="));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) values.delete(name);
      else values.set(name, pair.slice(equals + 1));
    },
  };
}

const silent = (): Channel => ({ announce: () => {}, subscribe: () => () => {} });

test("an answer stands for thirteen months and not a moment longer", () => {
  const decision = decisionAt("2026-08-16T10:00:00.000Z");

  assert.equal(CONSENT_MONTHS, 13);
  assert.equal(expiresAt(decision), "2027-09-16T10:00:00.000Z");
  assert.equal(expired(decision, new Date("2027-09-16T09:59:59Z")), false);
  assert.equal(expired(decision, new Date("2027-09-16T10:00:00Z")), true);
  // Thirteen months after the 31st is a date that does not exist.
  assert.equal(expiresAt(decisionAt("2026-01-31T00:00:00.000Z")), "2027-02-28T00:00:00.000Z");
  assert.equal(expired(decisionAt("whenever"), new Date("2026-08-16T10:00:00Z")), true);
});

test("localStorage keeps the whole log and reads it back", () => {
  const tab = fakeBrowser().tab();
  const store = localStore({ storage: tab.storage, events: tab.events, now: options.now });
  const state = withdraw(options, acceptAll(options));

  store.write(state.log);

  assert.deepEqual(store.read(), state.log);
  assert.equal(restore(store.read(), options).decision?.method, "withdrawn");
});

// A record outliving the answer is retention nobody asked for.
test("a record past thirteen months is not an answer, and does not stay in the browser", () => {
  const tab = fakeBrowser().tab();
  const stale = decisionAt("2025-01-01T00:00:00.000Z");
  tab.storage.setItem("consent", JSON.stringify([stale]));

  const store = localStore({ storage: tab.storage, events: tab.events, now: options.now });

  assert.equal(store.read(), null);
  assert.equal(tab.storage.getItem("consent"), null);
  assert.equal(restore(store.read(), options).pending, true);
});

test("an expired decision is dropped while a current one is kept", () => {
  const tab = fakeBrowser().tab();
  const current = decisionAt("2026-06-01T00:00:00.000Z");
  tab.storage.setItem(
    "consent",
    JSON.stringify([decisionAt("2025-01-01T00:00:00.000Z"), current]),
  );

  const store = localStore({ storage: tab.storage, events: tab.events, now: options.now });

  assert.deepEqual(store.read(), [current]);
  assert.deepEqual(JSON.parse(tab.storage.getItem("consent") ?? "null"), [current]);
});

test("a hand-edited record is refused rather than half read", () => {
  const tab = fakeBrowser().tab();
  const store = localStore({ storage: tab.storage, events: tab.events, now: options.now });

  for (const raw of ["not json", "42", '""', "{}", "[null]", '[{"method":"custom"}]']) {
    tab.storage.setItem("consent", raw);
    assert.equal(store.read(), null, raw);
  }
});

// A visitor with the site open twice who withdraws in one of them has withdrawn.
test("a decision in one tab reaches the other, and never echoes back to itself", () => {
  const browser = fakeBrowser();
  const one = browser.tab();
  const two = browser.tab();
  const here = localStore({ storage: one.storage, events: one.events, now: options.now });
  const there = localStore({ storage: two.storage, events: two.events, now: options.now });

  let heard = 0;
  let echoed = 0;
  const stop = there.subscribe?.(() => {
    heard += 1;
  });
  here.subscribe?.(() => {
    echoed += 1;
  });

  const state = acceptAll(options);
  here.write(state.log);

  assert.equal(heard, 1);
  assert.equal(echoed, 0);
  assert.deepEqual(there.read(), state.log);

  stop?.();
  here.write(withdraw(options, state).log);
  assert.equal(heard, 1, "unsubscribing has to actually stop it");
});

// Losing the record is bad. Throwing inside a banner is worse.
test("a storage that throws loses the record rather than the page", () => {
  const broken: StorageLike = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota exceeded");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  const store = localStore({ storage: broken, now: options.now });

  assert.equal(store.read(), null);
  assert.doesNotThrow(() => store.write(acceptAll(options).log));
  assert.doesNotThrow(() => store.subscribe?.(() => {})());
});

test("a cookie carries the decision and expires with it", () => {
  const jar = fakeJar();
  const store = cookieStore({ jar, now: options.now, channel: silent() });
  const state = acceptAll(options);

  store.write(state.log);

  assert.deepEqual(store.read(), state.log);
  const written = jar.writes[jar.writes.length - 1];
  assert.match(written, /^consent=/);
  assert.match(written, /Path=\//);
  assert.match(written, /SameSite=Lax/);
  assert.match(written, /Secure/);
  assert.equal(
    Number(/Max-Age=(\d+)/.exec(written)?.[1]),
    (Date.parse(expiresAt(state.log[0])) - Date.parse("2026-08-16T10:00:00.000Z")) / 1000,
  );
});

test("the cookie is read out of the others, and a mangled one reads as nothing", () => {
  const jar = fakeJar();
  jar.cookie = "_ga=GA1.1.2; Path=/";
  const store = cookieStore({ jar, now: options.now, channel: silent() });
  const state = acceptAll(options);

  store.write(state.log);
  assert.deepEqual(store.read(), state.log);

  jar.cookie = "consent=not-json; Path=/";
  assert.equal(store.read(), null);
});

test("an empty log deletes the cookie instead of writing an empty one", () => {
  const jar = fakeJar();
  const store = cookieStore({ jar, now: options.now, channel: silent() });

  store.write(acceptAll(options).log);
  store.write([]);

  assert.match(jar.writes[jar.writes.length - 1], /Max-Age=0/);
  assert.equal(store.read(), null);
  assert.equal(jar.cookie, "");
});

// A cookie over the limit is not rejected, it is silently not set.
test("a log too big for a cookie loses its oldest entries, not the latest answer", () => {
  const jar = fakeJar();
  const store = cookieStore({ jar, now: options.now, channel: silent(), limit: 300 });
  const log = [
    decisionAt("2026-06-01T00:00:00.000Z"),
    decisionAt("2026-07-01T00:00:00.000Z"),
    decisionAt("2026-08-01T00:00:00.000Z"),
  ];

  store.write(log);
  const kept = asLog(store.read());

  assert.ok(kept.length >= 1 && kept.length < log.length);
  assert.deepEqual(kept.at(-1), log[2]);
});

// Cookies fire no event of their own, so the other tabs are told over storage.
test("a cookie write is announced to the other tabs", () => {
  const browser = fakeBrowser();
  const one = browser.tab();
  const two = browser.tab();
  const jar = fakeJar();
  const here = cookieStore({
    jar,
    now: options.now,
    channel: storageChannel("consent.sync", { storage: one.storage, events: one.events }),
  });
  const there = cookieStore({
    jar,
    now: options.now,
    channel: storageChannel("consent.sync", { storage: two.storage, events: two.events }),
  });

  let heard = 0;
  there.subscribe?.(() => {
    heard += 1;
  });

  const state = acceptAll(options);
  here.write(state.log);

  assert.equal(heard, 1);
  assert.deepEqual(there.read(), state.log);
});

// Rendering on a server is ordinary, not an error the caller has to guard.
test("with no document a cookie store reads nothing and writes nothing", () => {
  const store = cookieStore({ now: options.now, channel: silent() });

  assert.equal(store.read(), null);
  assert.doesNotThrow(() => store.write(acceptAll(options).log));
});
