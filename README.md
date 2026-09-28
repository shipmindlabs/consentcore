# consentcore

GDPR consent as state you can reason about, rather than a banner that sets a
cookie and hopes.

Consent has to be freely given, specific, informed, as easy to withdraw as to
give — and **demonstrable**. That last word is the one products get wrong. A
banner that flips a boolean can say what the visitor chose. It cannot say when,
against which version of the notice, or what already ran before they chose.

```console
$ npm run demo
visitor arrives, nothing decided
  ran     : session cookie
  waiting : analytics, ad pixel
  marketing allowed: false

visitor accepts statistics only
  ran     : session cookie, analytics
  waiting : ad pixel

the notice text is edited; the version string is not
  old decision carried forward: false
  asked again                 : true
  kept in the log             : custom at 2026-08-16T10:00:00.000Z
```

## The gate

The bug this replaces is an ordering bug, not a UI one: an analytics snippet
that loads on page one and a banner that appears a moment later. The visitor's
choice arrives after the request did, and no amount of correct banner design
undoes that.

```ts
const gate = new Gate(state);

gate.when("necessary",  "session",   () => startSession());
gate.when("statistics", "analytics", () => loadAnalytics());
gate.when("marketing",  "pixel",     () => loadPixel());

// later, when the visitor decides
gate.update(accept(["statistics"], options));
```

Necessary work runs immediately and synchronously, so callers can rely on
ordering. Nothing runs twice however many decisions arrive. Work whose category
is withdrawn is **dropped**, not kept waiting — holding it in case they change
their mind is how a queue becomes a loophole.

## Third-party tags

Queued work is a one-shot side effect: it runs once and is over. A tag is not.
It keeps running, and consent can move under it after it started — so tags are
a registry rather than a queue.

```ts
const tags = new Tags(state);

tags.register({ id: "analytics", purpose: "statistics", src: "https://cdn.example/a.js" });
tags.register({
  id: "pixel",
  purpose: "marketing",
  src: "https://cdn.example/p.js",
  cleanup: () => { document.cookie = "_pxl=; Max-Age=0"; },
});

tags.update(accept(["statistics"], options));  // analytics goes on the page, the pixel does not
tags.update(withdraw(options, state));         // the analytics element is taken off it
```

Held until there is a decision, released only for the purposes that decision
granted, and on withdrawal **removed** — not left in place with
`type="text/plain"` to be revived later, which keeps a refused vendor one line
of unrelated code away from running. `cleanup` is where the cookie the tag set
gets dealt with, because taking an element off the page does not undo what it
already did.

Elements carry `data-consent-tag` and `data-consent-purpose`, so a page can be
inspected for what is running and under which answer. A later grant releases a
removed tag again: that is a new answer to the same question, not a replay of
the old one. `tags.history` is the record of both directions, and with no
document — server rendering — mounting is a no-op rather than a crash.

## Purposes and vendors

A category is a coarse answer. "statistics" does not say which vendor gets the
request, what they set, or where it goes. The list that does say it is usually
prose, written three times — in the banner, in the cookie policy and in a
record of processing — and the three drift apart. So it is declared once, as
data:

```ts
const declaration = declare({
  purposes: [
    { id: "session", category: "necessary", name: "Keeping you signed in",
      description: "A cookie that holds your session while you use the site." },
    { id: "audience", category: "statistics", name: "Counting visits",
      description: "Which pages are read, in aggregate." },
    { id: "retargeting", category: "marketing", name: "Advertising",
      description: "Showing you ads for this site on other sites." },
  ],
  vendors: [
    { id: "acme-analytics", name: "Acme Analytics", purposes: ["audience"],
      policy: "https://acme.example/privacy", cookies: ["_acme"], transfers: "US" },
    { id: "adnet", name: "AdNet", purposes: ["audience", "retargeting"] },
  ],
});
```

`declare` checks it rather than trusting it: a vendor may only name purposes
that exist, an id may only be used once, and a purpose with no description is
refused, because a notice made of ids informs nobody. What comes back is plain
data — it can be JSON, committed next to the code, diffed in review and
published beside the notice.

```ts
allowsPurpose(declaration, state, "audience");        // true
allowsVendor(declaration, state, "adnet");            // false: retargeting was not granted
runnable(declaration, state);                         // ["acme-analytics"]
vendorsFor(declaration, "audience");                  // both of them
purposesOf(declaration, "adnet");                     // what it is on the page to do
```

A vendor whose purposes are only partly granted does not run partly — it does
not run. Sending the request and leaving the vendor to honour the rest hands
the visitor's decision to the party it was made about.

The declaration is also what the notice is *about*, so it can be what the
notice is fingerprinted from: `noticeHash: declarationHash(declaration)` means
adding a vendor or rewriting a description asks everyone again. It is taken
over the declaration sorted by id, so moving a line in the file is not an edit.

### Refusing is the same call as accepting

```ts
grant(declaration,  ["audience"], options, state);
refuse(declaration, ["audience"], options, state);
```

Same parameters, same order, same return value, same entry in the log. "As easy
to withdraw as to give" is a property of the API before it is a property of the
banner: a refusal that needed a different call, an extra argument or a
confirmation step has already lost it, and no amount of button styling gets it
back. A grant adds to what was already granted, a refusal takes away what it
names, and `necessary` survives being named for the same reason `accept` adds
it.

A purpose is answered through its category, because a category is what a
decision records. Two purposes under one category are one answer; purposes that
need separate answers need separate categories.

## The notice a decision answered

Every decision records the notice version and a fingerprint of the notice text:

```ts
const options = { noticeVersion: "2026-08-01", noticeHash: hashNotice(noticeText) };
```

The version string is a promise someone has to remember to keep. The hash is
checkable, and it catches the edit that changed what the notice said without
changing what it was called. When either moves, `restore` returns to undecided
and the banner is due again — while the answer that was superseded stays in
`state.log`, where `superseded(state)` can find it. `hashNotice` is a change
fingerprint (FNV-1a), not a security hash.

## Where the record is kept

Two adapters, one shape:

```ts
const store = localStore();                              // the default
const store = cookieStore({ domain: ".example.com" });   // when the server has to know
```

`localStorage` is the default: the record is read by the page that wrote it and
by nothing else, and it rides on no request. A cookie is for the one case that
cannot serve — a server-rendered first response that has to know what was
chosen before any script has run — and it pays for that with bytes on every
request.

Both expire the record after thirteen months. Consent is not a signature
collected once: someone who answered a notice a year and a half ago has not
answered this one. Expiry is enforced on the way out as well as on the way in,
and what has expired leaves the browser rather than sitting there unread,
because a record outliving the answer is retention nobody asked for. The
cookie's own `Max-Age` comes from the decision, so the browser expires it on the
same schedule this code does and a tab left open for a year does not outlive it.

```ts
expiresAt(decision);   // "2027-09-16T10:00:00.000Z"
expired(decision);     // false, until it is not
```

### Two open tabs

A visitor with the site open twice who withdraws in one of them has withdrawn.
Both stores expose `subscribe`, carried by the `storage` event: it reaches every
other tab on the origin and never the one that wrote, which is exactly the shape
wanted here. It is not a `BroadcastChannel` because storage is already present,
already permitted, and already what the record is kept in. Writing a cookie
fires no event at all, so `cookieStore` announces itself over a `localStorage`
key that carries no record — `storageChannel`, which is also the seam a test
stands in for.

Neither store throws. Private browsing, quota and a browser setting that blocks
storage entirely are all ordinary; losing the record is bad, but throwing inside
a banner is worse, because then nobody can consent at all. A cookie over about
4 KB is not rejected either — it is silently not set — so a log too big for one
loses its oldest entries rather than the answer the visitor is living under.

## Proof export

The log is append-only in memory, which is a promise this library makes to
itself. A reviewer has no reason to accept it: a JSON file of decisions can be
edited in any text editor, and nothing in its shape shows that it was. So the
export chains each entry to the hash of the one before it.

```ts
writeFileSync("consent-proof.json", JSON.stringify(proof(state), null, 2));
```

```json
{
  "format": "consentcore/proof@1",
  "entries": [
    {
      "index": 0,
      "at": "2026-08-16T10:00:00.000Z",
      "purposes": ["necessary", "statistics"],
      "method": "custom",
      "noticeVersion": "2026-08-01",
      "noticeHash": "a1c1f39a4c52ebd8",
      "previous": "0000000000000000000000000000000000000000000000000000000000000000",
      "hash": "…"
    }
  ]
}
```

The chain is derived, never stored: nothing new goes into `localStorage`, two
exports of the same log are byte-identical, and anyone holding the log can
recompute it. `verifyProof(JSON.parse(text))` re-runs the whole check —
hashes, links, positions and timestamp order — and returns every problem it
found with the entry it belongs to, rather than stopping at the first.

The digest is SHA-256 over a preimage that is written down, so verifying an
export needs nothing from this package:

```js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const { format, entries } = JSON.parse(readFileSync("consent-proof.json", "utf8"));
let previous = "0".repeat(64);

for (const e of entries) {
  const preimage = JSON.stringify([
    format, e.index, e.at, e.method, e.purposes, e.noticeVersion, e.noticeHash, previous,
  ]);
  const hash = createHash("sha256").update(preimage).digest("hex");
  if (hash !== e.hash || previous !== e.previous) throw new Error(`entry ${e.index}`);
  previous = hash;
}
```

A JSON array rather than a joined line, because every field in it comes from a
caller: a `noticeVersion` containing a quote must not be able to pass itself
off as two fields.

**What a chain proves, and what it does not.** It makes an edit made in place
visible: the entry stops matching its own hash, and every entry after it stops
matching the chain. It cannot show a rewrite, because whoever holds the log can
recompute all of it — that is true of any unsigned chain, whatever the digest.
The way to close that gap is to put `chainHead(document)` somewhere the writer
does not control: a receipt to the visitor, a line in a log shipped off the
box, a hash recorded in a build artifact.

## Four refusals

**Silence is not consent.** Before any decision only `necessary` is allowed.
Code that treats "not answered yet" as permission is the violation these banners
exist to prevent.

**An old notice does not answer a new question.** A decision recorded against a
previous `noticeVersion` — or against text that has since been edited — is not
carried forward, and it is not deleted either. The visitor agreed to what that
version said, and the log has to be able to show it.

**`necessary` is not a choice.** It is in the type as its own category and is
granted whether or not it was passed, so no caller can accidentally make the
service unusable — or dishonestly reclassify tracking as essential.

**Withdrawal leaves a way back.** Withdrawing revokes everything and puts the
notice back on screen, rather than leaving someone with no way to change their
mind again.

## Use with React

```tsx
const consent = useConsent({ noticeVersion: "2026-08-01", noticeHash: hashNotice(noticeText) });

if (consent.pending) return <Notice onAccept={consent.acceptAll} onReject={consent.rejectAll} />;
if (consent.allows("statistics")) { /* … */ }
```

The bundled store is `localStore`, and a decision made in another tab arrives
through it without the caller wiring anything up. `consent.persisted` tells you
when the record did not stick. It keeps the whole log, not just the last answer,
because a superseded decision is the part worth being able to show — and
`proof(consent.log)` is that log in a shape a reviewer can check. Pass
`store: cookieStore()` when the server has to read the answer too.

## What it is not

**Not a banner.** No markup, no styles, no copy. Consent notices are
design-system work and a library that ships one is always fought.

**Not the IAB TCF.** The purposes and vendors here are your own declaration, in
your own words. There is no global vendor list, no consent string and no
framework policy to be audited against; that is a different and much larger job.

**Not legal advice.** It records decisions in a defensible shape. Whether your
notice, your categories and your retention satisfy a particular supervisory
authority is a question for someone qualified to answer it.

## Status

| | |
|---|---|
| Core | four categories, decision record with timestamp, notice version and hash, method, an append-only log, restore, withdrawal |
| Declaration | purposes and vendors as plain data, checked on `declare`, a fingerprint over the declaration, per-purpose grant and refusal with one signature |
| Proof | the log as a SHA-256 chain, JSON export, an offline verifier that reports every problem it finds |
| Gate | deferred side effects per category, ordered, once only, droppable |
| Tags | third-party scripts held until a decision, released per purpose, removed and cleaned up when consent goes away |
| Storage | `localStorage` and cookie adapters, a thirteen-month expiry enforced on read and on write, cross-tab sync over the `storage` event |
| React | `useConsent`, wired to a store and to the other tabs, tested with a real render |
| Not yet | Google Consent Mode signals, a signature or external anchor over the chain head |

## Development

```bash
npm test        # node --test, including React renders
npm run demo
npm run typecheck
```

## License

MIT © [Shipmind Labs](https://shipmindlabs.com)
