/**
 * Holding work back until consent exists, and running it in order once it does.
 *
 * The bug this replaces: an analytics snippet that loads on page one and a
 * banner that appears a moment later. The visitor's choice arrives after the
 * request did, and no amount of correct banner UI undoes that.
 */

import { allows, type Category, type State } from "./consent.ts";

type Waiting = {
  readonly category: Category;
  readonly run: () => void;
  readonly label: string;
};

export type RunRecord = {
  readonly label: string;
  readonly category: Category;
  readonly at: string;
};

/**
 * A queue of side effects that each need one category.
 *
 * Nothing runs until the category is granted, and nothing runs twice — a second
 * grant after a withdrawal does not replay what already happened.
 */
export class Gate {
  #waiting: Waiting[] = [];
  #ran: RunRecord[] = [];
  #state: State;
  #now: () => Date;

  constructor(state: State, options: { now?: () => Date } = {}) {
    this.#state = state;
    this.#now = options.now ?? (() => new Date());
  }

  get pending(): readonly string[] {
    return this.#waiting.map((item) => item.label);
  }

  /** What has run, in order, with the category that permitted it. */
  get ran(): readonly RunRecord[] {
    return this.#ran;
  }

  /**
   * Register work. If the category is already granted it runs immediately —
   * synchronously, so a caller can rely on ordering rather than on a tick.
   */
  when(category: Category, label: string, run: () => void): this {
    const item: Waiting = { category, label, run };
    if (allows(this.#state, category)) {
      this.#execute(item);
      return this;
    }
    this.#waiting.push(item);
    return this;
  }

  /** A decision arrived. Everything now permitted runs, in registration order. */
  update(state: State): this {
    this.#state = state;
    const ready = this.#waiting.filter((item) => allows(state, item.category));
    this.#waiting = this.#waiting.filter((item) => !allows(state, item.category));
    for (const item of ready) this.#execute(item);
    return this;
  }

  /**
   * Work whose consent was withdrawn is dropped rather than kept waiting: the
   * visitor said no, and holding it in case they change their mind is how a
   * queue becomes a loophole.
   */
  forget(category: Category): this {
    this.#waiting = this.#waiting.filter((item) => item.category !== category);
    return this;
  }

  #execute(item: Waiting): void {
    this.#ran.push({
      label: item.label,
      category: item.category,
      at: this.#now().toISOString(),
    });
    item.run();
  }
}
