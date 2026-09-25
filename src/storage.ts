/**
 * Where a decision is kept between visits, and how two open tabs stay on the
 * same answer.
 *
 * Two adapters, one shape. `localStorage` is the default: the record is read by
 * the page that wrote it and by nothing else, and it rides on no request. A
 * cookie is for the case that cannot serve — a server-rendered first response
 * that has to know what was chosen before any script has run.
 *
 * Both expire the record after thirteen months. Consent is not a signature
 * collected once: someone who answered a notice a year and a half ago has not
 * answered this one, and a record kept past the point where it still means
 * something is retention nobody asked for.
 */

import { asLog, type Decision, type StoredConsent } from "./consent.ts";

/** How long an answer stands before the question is asked again. */
export const CONSENT_MONTHS = 13;

/** Browsers drop a cookie larger than about 4 KB without saying so. */
export const COOKIE_LIMIT = 4000;

/** Somewhere to keep the decisions between visits. */
export type Store = {
  read(): StoredConsent;
  /**
   * The whole log, not only the latest decision: a superseded answer is part of
   * the record, and a store that keeps just the last one cannot show it.
   */
  write(log: readonly Decision[]): void;
  /**
   * Called when another tab writes; returns the way to stop listening. Absent
   * on a store that cannot tell, which is why callers reach for it optionally.
   */
  subscribe?(listener: () => void): () => void;
};

/** The part of `localStorage` used here, named so a test can stand in for it. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StorageEvent = { readonly key: string | null };

export type StorageEventTarget = {
  addEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
};

export type Channel = {
  announce(): void;
  subscribe(listener: () => void): () => void;
};

function storageOf(given?: StorageLike): StorageLike | undefined {
  return given ?? (globalThis as unknown as { localStorage?: StorageLike }).localStorage;
}

function eventsOf(given?: StorageEventTarget): StorageEventTarget | undefined {
  return given ?? (globalThis as unknown as { window?: StorageEventTarget }).window;
}

function addMonths(date: Date, months: number): Date {
  const moved = new Date(date.getTime());
  const day = moved.getUTCDate();
  moved.setUTCMonth(moved.getUTCMonth() + months);
  // The 31st of a month that has no 31st rolls forward on its own; rolling back
  // to the last day of the intended month is the shorter window of the two.
  if (moved.getUTCDate() !== day) moved.setUTCDate(0);
  return moved;
}

/** When a decision stops being an answer. A timestamp nobody can read is over. */
export function expiresAt(decision: Decision, months = CONSENT_MONTHS): string {
  const at = Date.parse(decision.at);
  if (Number.isNaN(at)) return new Date(0).toISOString();
  return addMonths(new Date(at), months).toISOString();
}

export function expired(decision: Decision, now = new Date(), months = CONSENT_MONTHS): boolean {
  return now.getTime() >= Date.parse(expiresAt(decision, months));
}

// Whatever a store hands back was a string a moment ago, in a place the visitor
// can edit. Nothing here may assume it is shaped the way it was written.
function readable(decision: Decision): boolean {
  return typeof decision === "object" && decision !== null && typeof decision.at === "string";
}

/** The decisions still inside the window, oldest first. */
export function fresh(
  stored: StoredConsent,
  now = new Date(),
  months = CONSENT_MONTHS,
): readonly Decision[] {
  return asLog(stored).filter((decision) => readable(decision) && !expired(decision, now, months));
}

function parse(raw: string | null): StoredConsent {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    if (Array.isArray(value)) return value as readonly Decision[];
    return "method" in value ? (value as Decision) : null;
  } catch {
    return null;
  }
}

/**
 * Telling the other tabs, over a `localStorage` key that carries no record.
 *
 * A `storage` event reaches every other tab on the origin and never the one
 * that wrote, which is the shape wanted here and the reason this is not a
 * `BroadcastChannel`: storage is already present, already permitted, and
 * already what the record is kept in.
 */
export function storageChannel(
  name: string,
  where: { storage?: StorageLike; events?: StorageEventTarget } = {},
): Channel {
  let ticks = 0;
  return {
    announce() {
      try {
        ticks += 1;
        // The event only fires when the value changes, so the value has to.
        storageOf(where.storage)?.setItem(name, `${Date.now()}.${ticks}`);
      } catch {
        // Nobody was told, which is the outcome a closed tab has anyway.
      }
    },
    subscribe(listener) {
      const target = eventsOf(where.events);
      if (!target) return () => {};
      const handler = (event: StorageEvent) => {
        if (event.key === null || event.key === name) listener();
      };
      target.addEventListener("storage", handler);
      return () => target.removeEventListener("storage", handler);
    },
  };
}

export type LocalStoreOptions = {
  key?: string;
  storage?: StorageLike;
  events?: StorageEventTarget;
  now?: () => Date;
  months?: number;
};

/**
 * A store backed by localStorage, written so that a blocked or full storage
 * does not take the page down with it.
 *
 * Storage failing is not exotic: private browsing, quota, and a browser setting
 * that blocks it entirely are all ordinary. Losing the record is bad; throwing
 * inside a banner is worse, because then nobody can consent at all.
 */
export function localStore(options: LocalStoreOptions = {}): Store {
  const key = options.key ?? "consent";
  const now = options.now ?? (() => new Date());
  const months = options.months ?? CONSENT_MONTHS;

  return {
    read() {
      try {
        const storage = storageOf(options.storage);
        const stored = parse(storage?.getItem(key) ?? null);
        const keep = fresh(stored, now(), months);
        // What has expired leaves the browser rather than sitting there unread:
        // a record outliving the answer is the retention this rule is about.
        if (storage && keep.length !== asLog(stored).length) {
          if (keep.length) storage.setItem(key, JSON.stringify(keep));
          else storage.removeItem(key);
        }
        return keep.length ? keep : null;
      } catch {
        return null;
      }
    },

    write(log) {
      try {
        const storage = storageOf(options.storage);
        const keep = fresh(log, now(), months);
        if (keep.length) storage?.setItem(key, JSON.stringify(keep));
        else storage?.removeItem(key);
      } catch {
        // Recorded nowhere, which the caller can see via `persisted`.
      }
    },

    subscribe(listener) {
      const target = eventsOf(options.events);
      if (!target) return () => {};
      const handler = (event: StorageEvent) => {
        if (event.key === null || event.key === key) listener();
      };
      target.addEventListener("storage", handler);
      return () => target.removeEventListener("storage", handler);
    },
  };
}

/** The part of `document` a cookie needs. */
export type CookieJar = { cookie: string };

export type CookieStoreOptions = {
  key?: string;
  jar?: CookieJar;
  /** How other tabs are told, since a cookie write fires no event of its own. */
  channel?: Channel;
  now?: () => Date;
  months?: number;
  path?: string;
  domain?: string;
  sameSite?: "Lax" | "Strict" | "None";
  /** On by default. A plain-http origin drops it, and `persisted` says so. */
  secure?: boolean;
  limit?: number;
};

/**
 * A store backed by a cookie, for when the server has to know the answer.
 *
 * The cookie's own `Max-Age` comes from the decision, so the browser expires the
 * record on the same schedule this code does and a tab left open for a year does
 * not outlive it.
 */
export function cookieStore(options: CookieStoreOptions = {}): Store {
  const key = options.key ?? "consent";
  const now = options.now ?? (() => new Date());
  const months = options.months ?? CONSENT_MONTHS;
  const limit = options.limit ?? COOKIE_LIMIT;
  const channel = options.channel ?? storageChannel(`${key}.sync`);
  const jar = () => options.jar ?? (globalThis as unknown as { document?: CookieJar }).document;

  const attributes = (maxAge: number): string => {
    const parts = [
      `Max-Age=${maxAge}`,
      `Path=${options.path ?? "/"}`,
      `SameSite=${options.sameSite ?? "Lax"}`,
    ];
    if (options.domain) parts.push(`Domain=${options.domain}`);
    if (options.secure ?? true) parts.push("Secure");
    return parts.join("; ");
  };

  const value = (): string | null => {
    for (const pair of (jar()?.cookie ?? "").split(";")) {
      const equals = pair.indexOf("=");
      if (equals < 0 || pair.slice(0, equals).trim() !== key) continue;
      try {
        return decodeURIComponent(pair.slice(equals + 1).trim());
      } catch {
        return null;
      }
    }
    return null;
  };

  const put = (log: readonly Decision[]): void => {
    const document = jar();
    if (!document) return;
    if (!log.length) {
      document.cookie = `${key}=; ${attributes(0)}`;
      return;
    }

    // A cookie over the size limit is not rejected, it is silently not set. The
    // oldest decisions go rather than the answer the visitor is living under.
    const keep = [...log];
    let encoded = encodeURIComponent(JSON.stringify(keep));
    while (keep.length > 1 && key.length + encoded.length > limit) {
      keep.shift();
      encoded = encodeURIComponent(JSON.stringify(keep));
    }
    if (key.length + encoded.length > limit) return;

    const last = keep[keep.length - 1];
    const seconds = Math.max(
      0,
      Math.round((Date.parse(expiresAt(last, months)) - now().getTime()) / 1000),
    );
    document.cookie = `${key}=${encoded}; ${attributes(seconds)}`;
  };

  return {
    read() {
      const stored = parse(value());
      const keep = fresh(stored, now(), months);
      if (keep.length !== asLog(stored).length) put(keep);
      return keep.length ? keep : null;
    },

    write(log) {
      put(fresh(log, now(), months));
      channel.announce();
    },

    subscribe: (listener) => channel.subscribe(listener),
  };
}
