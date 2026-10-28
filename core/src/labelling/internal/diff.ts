/**
 * The diff functions behind undo/redo. Every undoable op line has a `diff` with what it changed, per object. Undo
 * applies the inverse and redo applies it again. A diff that doesn't fit the current objects is refused whole.
 */
import { err, ok } from "neverthrow";
import type { DetId } from "../../detections/pure.ts";
import type { ApplyDiff, Change, Diff, DiffObjects, InvertDiff, Obj, Objects, Owner, ReplayFailure } from "../model.ts";
import { isOwner } from "../model.ts";

const changeOf = (b: Obj | undefined, a: Obj | undefined): Change | null => {
  if (b === undefined && a !== undefined)
    return { from: null, to: a.label, ...(a.members.length ? { add: [...a.members] } : {}) };
  if (b !== undefined && a === undefined)
    return { from: b.label, to: null, ...(b.members.length ? { remove: [...b.members] } : {}) };
  if (b === undefined || a === undefined) return null;
  const had = new Set(b.members),
    has = new Set(a.members);
  const add = a.members.filter((m) => !had.has(m));
  const remove = b.members.filter((m) => !has.has(m));
  const c: Change = {
    ...(b.label !== a.label ? { from: b.label, to: a.label } : {}),
    ...(add.length ? { add } : {}),
    ...(remove.length ? { remove } : {}),
  };
  return Object.keys(c).length ? c : null;
};

/**
 * The label change and members gained or lost for each changed object, in `before`'s order and then new ones.
 * Unchanged objects are left out.
 */
export const diffObjects: DiffObjects = (before, after) => {
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  return Object.fromEntries(
    keys.flatMap((k) => {
      const c = changeOf(before.get(k), after.get(k));
      return c === null ? [] : [[k, c] as const];
    }),
  );
};

export const invertDiff: InvertDiff = (d) =>
  Object.fromEntries(
    Object.entries(d).map(([k, c]): [string, Change] => [
      k,
      {
        ...("to" in c ? { from: c.to } : {}),
        ...("from" in c ? { to: c.from } : {}),
        ...(c.remove?.length ? { add: [...c.remove] } : {}),
        ...(c.add?.length ? { remove: [...c.add] } : {}),
      },
    ]),
  );

const lookup = (objects: Objects, k: string): Obj | undefined => (isOwner(k) ? objects.get(k) : undefined);

/** Why `d` doesn't start from `objects`, checked object by object in diff order, or null if it does. */
const conflict = (objects: Objects, d: Diff): ReplayFailure | null => {
  for (const [k, c] of Object.entries(d)) {
    const o = lookup(objects, k);
    if (!isOwner(k)) return { kind: "not-an-object", obj: k };
    if (c.from === null) {
      if (o) return { kind: "exists", obj: k };
      continue;
    }
    if (!o) return { kind: "gone", obj: k };
    if (typeof c.from === "string" && o.label !== c.from)
      return { kind: "label-mismatch", obj: k, actual: o.label, expected: c.from };
    const has = new Set<string>(o.members);
    const missing = (c.remove ?? []).filter((m) => !has.has(m));
    if (missing.length) return { kind: "members-missing", obj: k, ids: missing };
    const present = (c.add ?? []).filter((m) => has.has(m) && !(c.remove ?? []).includes(m));
    if (present.length) return { kind: "members-present", obj: k, ids: present };
  }
  return null;
};

/**
 * `objects` with `d` applied, or why not. It never applies part of a diff. Removals go first everywhere, so a
 * member that moves between objects is never in two at once. Deletions, creations (appended), label changes and
 * additions follow, in diff order.
 */
export const applyDiff: ApplyDiff = (objects, d) => {
  const why = conflict(objects, d);
  if (why !== null) return err(why);
  const entries = Object.entries(d).flatMap(([k, c]) => (isOwner(k) ? [[k, c] as const] : []));
  const removed = new Map<Owner, readonly DetId[]>(
    entries.flatMap(([k, c]) => (c.remove?.length ? [[k, c.remove] as const] : [])),
  );
  const stripped: Objects = new Map(
    [...objects].map(([k, o]): [Owner, Obj] => {
      const gone = removed.get(k);
      if (gone === undefined || d[k]?.from === null) return [k, o];
      const g = new Set(gone);
      return [k, { label: o.label, members: o.members.filter((m) => !g.has(m)) }];
    }),
  );
  const next = entries.reduce<Objects>((acc, [k, c]) => {
    if (c.to === null) return new Map([...acc].filter(([j]) => j !== k));
    const o = acc.get(k);
    const base: Obj = c.from === null || o === undefined ? { label: c.to ?? "", members: [] } : o;
    const updated: Obj = {
      label: c.from !== null && typeof c.to === "string" ? c.to : base.label,
      members: c.add?.length ? [...base.members, ...c.add] : base.members,
    };
    return c.from === null
      ? new Map([...[...acc].filter(([j]) => j !== k), [k, updated]])
      : new Map([...acc].map(([j, x]) => [j, j === k ? updated : x]));
  }, stripped);
  return ok(next);
};
