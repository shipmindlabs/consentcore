/**
 * Third-party tags, registered against a purpose and held until the visitor
 * has decided.
 *
 * Queued work is a one-shot side effect: it runs once and is over. A tag is
 * not. It keeps running, and consent can move under it after it started, so
 * this is a registry rather than a queue. A tag stays registered whatever the
 * current answer is; what changes is whether it is on the page.
 *
 * When a purpose is refused or withdrawn the element is removed. The usual
 * shortcut — leaving the script in place with `type="text/plain"` and swapping
 * it back later — keeps a refused vendor one line of unrelated code away from
 * running, which is not what the visitor was told.
 */

import { allows, type Category, type State } from "./consent.ts";

/** Written on every element this mounts, so a page can be inspected. */
export const TAG_ATTRIBUTE = "data-consent-tag";
export const PURPOSE_ATTRIBUTE = "data-consent-purpose";

export type Tag = {
  readonly id: string;
  readonly purpose: Category;
  readonly src?: string;
  /** For vendors that hand over a block of code rather than a URL. */
  readonly inline?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  /**
   * Undo what the tag did. Taking the element off the page stops nothing that
   * already started: the cookie it wrote, the interval it set and whatever it
   * hung on `window` all outlive it, and this is where they are dealt with.
   */
  readonly cleanup?: () => void;
};

export type TagEvent = {
  readonly id: string;
  readonly purpose: Category;
  readonly action: "released" | "revoked";
  readonly at: string;
};

export class DuplicateTag extends Error {}

/**
 * The part of the DOM a script element needs, named here so a test — or a
 * renderer that is not a browser — can stand in for it without a fake window.
 */
export type TagElement = {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
};

export type TagRoot = {
  append(node: TagElement): void;
  querySelectorAll(selector: string): ArrayLike<TagElement>;
};

export type TagDocument = {
  createElement(name: string): TagElement;
  readonly head: TagRoot;
};

/** Where a released tag goes and where a revoked one is taken from. */
export type TagHost = {
  mount(tag: Tag): void;
  unmount(tag: Tag): void;
};

/**
 * Scripts in the document head, or wherever `root` points.
 *
 * With no document there is nothing to mount and nothing to remove, so both
 * calls do nothing: server rendering must not be a special case the caller has
 * to remember.
 */
export function domHost(where: { document?: TagDocument; root?: TagRoot } = {}): TagHost {
  // Looked up per call, not once: a module imported during server rendering
  // has no document, and the same host has to work after hydration.
  const owner = () =>
    where.document ?? (globalThis.document as unknown as TagDocument | undefined);

  return {
    mount(tag) {
      const document = owner();
      const root = where.root ?? document?.head;
      if (!document || !root) return;

      const element = document.createElement("script");
      element.setAttribute(TAG_ATTRIBUTE, tag.id);
      element.setAttribute(PURPOSE_ATTRIBUTE, tag.purpose);
      for (const [name, value] of Object.entries(tag.attributes ?? {})) {
        element.setAttribute(name, value);
      }
      if (tag.src) element.setAttribute("src", tag.src);
      if (tag.inline !== undefined) element.textContent = tag.inline;
      root.append(element);
    },

    unmount(tag) {
      const root = where.root ?? owner()?.head;
      if (!root) return;
      // Matched by reading the attribute rather than by building a selector:
      // the id comes from a caller, and a selector would have to escape it.
      for (const element of Array.from(root.querySelectorAll(`[${TAG_ATTRIBUTE}]`))) {
        if (element.getAttribute(TAG_ATTRIBUTE) === tag.id) element.remove();
      }
    },
  };
}

/**
 * Tags and the purposes they were registered against.
 *
 * Held until a decision, released only for the purposes that decision granted,
 * and removed when it is withdrawn or superseded. A later grant releases them
 * again, because that is a new answer to the same question rather than a replay
 * of the old one.
 */
export class Tags {
  #host: TagHost;
  #now: () => Date;
  #state: State;
  #registry = new Map<string, Tag>();
  #live = new Set<string>();
  #history: TagEvent[] = [];

  constructor(state: State, options: { host?: TagHost; now?: () => Date } = {}) {
    this.#state = state;
    this.#host = options.host ?? domHost();
    this.#now = options.now ?? (() => new Date());
  }

  /** Registered, permitted, and on the page. */
  get live(): readonly string[] {
    return [...this.#live];
  }

  /** Registered and waiting for a purpose that is not granted. */
  get held(): readonly string[] {
    return [...this.#registry.keys()].filter((id) => !this.#live.has(id));
  }

  /** What was released and what was removed, in order, with the time. */
  get history(): readonly TagEvent[] {
    return this.#history;
  }

  /**
   * Register a tag. If its purpose is already granted it goes on the page at
   * once, synchronously, so a caller can rely on ordering rather than a tick.
   */
  register(tag: Tag): this {
    if (this.#registry.has(tag.id)) {
      throw new DuplicateTag(`a tag called "${tag.id}" is already registered`);
    }
    this.#registry.set(tag.id, tag);
    if (allows(this.#state, tag.purpose)) this.#release(tag);
    return this;
  }

  /**
   * A decision arrived. Newly permitted tags are released in registration
   * order, and anything the decision no longer permits is removed.
   */
  update(state: State): this {
    this.#state = state;
    for (const tag of this.#registry.values()) {
      const permitted = allows(state, tag.purpose);
      if (permitted && !this.#live.has(tag.id)) this.#release(tag);
      if (!permitted && this.#live.has(tag.id)) this.#revoke(tag);
    }
    return this;
  }

  /** Drop a tag for good: removed if live, and no later decision brings it back. */
  unregister(id: string): this {
    const tag = this.#registry.get(id);
    if (!tag) return this;
    this.#registry.delete(id);
    if (this.#live.has(id)) this.#revoke(tag);
    return this;
  }

  #release(tag: Tag): void {
    this.#host.mount(tag);
    this.#live.add(tag.id);
    this.#record(tag, "released");
  }

  #revoke(tag: Tag): void {
    this.#live.delete(tag.id);
    this.#host.unmount(tag);
    tag.cleanup?.();
    this.#record(tag, "revoked");
  }

  #record(tag: Tag, action: TagEvent["action"]): void {
    this.#history.push({
      id: tag.id,
      purpose: tag.purpose,
      action,
      at: this.#now().toISOString(),
    });
  }
}
