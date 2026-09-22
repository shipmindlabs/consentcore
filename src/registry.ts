/**
 * Purposes and vendors, declared as data.
 *
 * A category is a coarse answer. "statistics" does not say which vendor gets
 * the request, what they set, or where it goes. The list that does say it is
 * usually prose, written three times — in the banner, in the cookie policy and
 * in a record of processing — and the three drift apart. Here it is one
 * structure the notice, the gate and the record can all read.
 *
 * Granting and refusing are the same call with the same arguments, because a
 * refusal that takes a different shape is a refusal that ends up harder.
 */

import {
  accept,
  allows,
  CATEGORIES,
  hashNotice,
  type Category,
  type Options,
  type State,
} from "./consent.ts";

export class InvalidDeclaration extends Error {}

/**
 * One reason data is processed, in the words the visitor is shown. The category
 * is what a decision records; the purpose is what the notice has to be able to
 * say about it.
 */
export type Purpose = {
  readonly id: string;
  readonly category: Category;
  /** A heading a notice can show. */
  readonly name: string;
  /** What is actually done. Without it the notice does not inform anyone. */
  readonly description: string;
};

export type Vendor = {
  readonly id: string;
  readonly name: string;
  /** Ids of the purposes this vendor processes for; each one must be declared. */
  readonly purposes: readonly string[];
  readonly policy?: string;
  /** Cookie names it sets, which is what a visitor inspecting their browser sees. */
  readonly cookies?: readonly string[];
  /** Where the data ends up, when that is somewhere the visitor should be told about. */
  readonly transfers?: string;
};

export type Declaration = {
  readonly purposes: readonly Purpose[];
  readonly vendors: readonly Vendor[];
};

/**
 * Check a declaration and hand it back.
 *
 * Every failure caught here is one a reviewer would otherwise find in the
 * notice: a vendor filed under a purpose nobody declared, two purposes sharing
 * an id so one of them can never be shown, a purpose with no description.
 *
 * The result is plain data — no class, no hidden index — so it can be JSON,
 * committed next to the code, diffed in review and published beside the notice.
 */
export function declare(source: Declaration): Declaration {
  const purposes = new Set<string>();
  for (const purpose of source.purposes) {
    if (!purpose.id) throw new InvalidDeclaration("a purpose without an id cannot be named");
    if (purposes.has(purpose.id)) {
      throw new InvalidDeclaration(`the purpose id "${purpose.id}" is declared twice`);
    }
    if (!CATEGORIES.includes(purpose.category)) {
      throw new InvalidDeclaration(`"${purpose.category}" is not a consent category`);
    }
    if (!purpose.name || !purpose.description) {
      throw new InvalidDeclaration(`purpose "${purpose.id}" has nothing to show the visitor`);
    }
    purposes.add(purpose.id);
  }

  const vendors = new Set<string>();
  for (const vendor of source.vendors) {
    if (!vendor.id) throw new InvalidDeclaration("a vendor without an id cannot be named");
    if (vendors.has(vendor.id)) {
      throw new InvalidDeclaration(`the vendor id "${vendor.id}" is declared twice`);
    }
    if (!vendor.name) throw new InvalidDeclaration(`vendor "${vendor.id}" has no name to show`);
    if (!vendor.purposes.length) {
      throw new InvalidDeclaration(`vendor "${vendor.id}" declares no purpose`);
    }
    for (const id of vendor.purposes) {
      if (!purposes.has(id)) {
        throw new InvalidDeclaration(`vendor "${vendor.id}" names an undeclared purpose "${id}"`);
      }
    }
    vendors.add(vendor.id);
  }

  return { purposes: [...source.purposes], vendors: [...source.vendors] };
}

/**
 * An unknown id throws rather than returning nothing. A mistyped purpose that
 * quietly matches no one reads as a refusal in one direction and as an empty
 * grant in the other, and neither is what the caller wrote.
 */
export function purpose(declaration: Declaration, id: string): Purpose {
  const found = declaration.purposes.find((candidate) => candidate.id === id);
  if (!found) throw new InvalidDeclaration(`no purpose called "${id}" is declared`);
  return found;
}

export function vendor(declaration: Declaration, id: string): Vendor {
  const found = declaration.vendors.find((candidate) => candidate.id === id);
  if (!found) throw new InvalidDeclaration(`no vendor called "${id}" is declared`);
  return found;
}

export function purposesOf(declaration: Declaration, vendorId: string): readonly Purpose[] {
  return vendor(declaration, vendorId).purposes.map((id) => purpose(declaration, id));
}

export function vendorsFor(declaration: Declaration, purposeId: string): readonly Vendor[] {
  purpose(declaration, purposeId);
  return declaration.vendors.filter((candidate) => candidate.purposes.includes(purposeId));
}

/**
 * The categories a set of purposes answers to, in the order categories are
 * declared in rather than the order they were asked for.
 */
export function categoriesOf(
  declaration: Declaration,
  purposeIds: readonly string[],
): readonly Category[] {
  const wanted = new Set(purposeIds.map((id) => purpose(declaration, id).category));
  return CATEGORIES.filter((category) => wanted.has(category));
}

export function allowsPurpose(
  declaration: Declaration,
  state: State,
  purposeId: string,
): boolean {
  return allows(state, purpose(declaration, purposeId).category);
}

/**
 * A vendor may run only when every purpose it declared is permitted. Running it
 * on a partial grant would send the request anyway and leave the vendor to
 * honour the rest, which is the visitor's decision handed to the party it was
 * made about.
 */
export function allowsVendor(declaration: Declaration, state: State, vendorId: string): boolean {
  return purposesOf(declaration, vendorId).every((item) => allows(state, item.category));
}

/** The vendors this decision permits, in declaration order. */
export function runnable(declaration: Declaration, state: State): readonly string[] {
  return declaration.vendors
    .filter((candidate) => allowsVendor(declaration, state, candidate.id))
    .map((candidate) => candidate.id);
}

/**
 * A fingerprint of the declaration, for use as `noticeHash`.
 *
 * The declaration is what the notice is about, so adding a vendor or rewriting
 * a description is a new question and everyone is asked again. Sorted by id and
 * written field by field, so moving a line in the file is not an edit and a
 * renamed field cannot pass unnoticed.
 */
export function declarationHash(declaration: Declaration): string {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
  const purposes = [...declaration.purposes]
    .sort(byId)
    .map((item) => [item.id, item.category, item.name, item.description]);
  const vendors = [...declaration.vendors]
    .sort(byId)
    .map((item) => [
      item.id,
      item.name,
      [...item.purposes].sort(),
      item.policy ?? "",
      [...(item.cookies ?? [])].sort(),
      item.transfers ?? "",
    ]);
  return hashNotice(JSON.stringify([purposes, vendors]));
}

function standing(previous?: State): readonly Category[] {
  if (!previous?.decision || previous.decision.method === "withdrawn") return ["necessary"];
  return previous.decision.granted;
}

/**
 * Grant some purposes, keeping whatever was already granted.
 *
 * A purpose is answered through its category, because that is what a decision
 * records: two purposes sharing a category are one answer, and purposes that
 * need separate answers need separate categories.
 */
export function grant(
  declaration: Declaration,
  purposes: readonly string[],
  options: Options,
  previous?: State,
): State {
  const granted = new Set([...standing(previous), ...categoriesOf(declaration, purposes)]);
  return accept([...granted], options, previous);
}

/**
 * Refuse some purposes, keeping whatever was not named.
 *
 * Same parameters in the same order as `grant`, returning the same thing and
 * recorded the same way. "As easy to withdraw as to give" is a property of the
 * API before it is a property of the banner: a refusal that needed a different
 * call, a different shape or a confirmation would already have lost it.
 * `necessary` survives being named, for the same reason `accept` adds it.
 */
export function refuse(
  declaration: Declaration,
  purposes: readonly string[],
  options: Options,
  previous?: State,
): State {
  const refused = new Set(categoriesOf(declaration, purposes));
  return accept(
    standing(previous).filter((category) => !refused.has(category)),
    options,
    previous,
  );
}
