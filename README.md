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

the notice text changes to a new version
  old decision carried forward: false
  asked again                 : true
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

## Four refusals

**Silence is not consent.** Before any decision only `necessary` is allowed.
Code that treats "not answered yet" as permission is the violation these banners
exist to prevent.

**An old notice does not answer a new question.** A decision recorded against a
previous `noticeVersion` is not carried forward. The visitor agreed to what that
version said.

**`necessary` is not a choice.** It is in the type as its own category and is
granted whether or not it was passed, so no caller can accidentally make the
service unusable — or dishonestly reclassify tracking as essential.

**Withdrawal leaves a way back.** Withdrawing revokes everything and puts the
notice back on screen, rather than leaving someone with no way to change their
mind again.

## Use with React

```tsx
const consent = useConsent({ noticeVersion: "2026-08-01" });

if (consent.pending) return <Notice onAccept={consent.acceptAll} onReject={consent.rejectAll} />;
if (consent.allows("statistics")) { /* … */ }
```

The bundled store uses `localStorage` and never throws: private browsing, quota
and a browser that blocks storage entirely are all ordinary. Losing the record
is bad, but throwing inside a banner is worse, because then nobody can consent
at all. `consent.persisted` tells you when the record did not stick.

## What it is not

**Not a banner.** No markup, no styles, no copy. Consent notices are
design-system work and a library that ships one is always fought.

**Not a vendor list or a TCF implementation.** No IAB framework, no vendor
strings, no purposes taxonomy. Those are a different and much larger job.

**Not legal advice.** It records decisions in a defensible shape. Whether your
notice, your categories and your retention satisfy a particular supervisory
authority is a question for someone qualified to answer it.

## Status

| | |
|---|---|
| Core | four categories, decision record with timestamp, notice version and method, restore, withdrawal |
| Gate | deferred side effects per category, ordered, once only, droppable |
| React | `useConsent`, a storage-failure-tolerant `localStore`, tested with a real render |
| Not yet | Google Consent Mode signals, a cookie-backed store for server rendering, per-vendor granularity, an audit export |

## Development

```bash
npm test        # node --test, including React renders
npm run demo
npm run typecheck
```

## License

MIT
