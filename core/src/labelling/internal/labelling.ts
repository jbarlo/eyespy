/** The Labelling instance. Its state is replaced, never edited, and only after LabelLog.commit succeeds. */
import type { Result, ResultAsync } from "neverthrow";
import { errAsync, okAsync } from "neverthrow";
import type { DetId, Detection } from "../../detections/pure.ts";
import { invariant } from "../../invariant/index.ts";
import type { Appearance } from "../../perception/pure.ts";
import type { ClipKey, FrameNo } from "../../video/pure.ts";
import type {
  Diff,
  HistoryState,
  HistoryView,
  Obj,
  ObjectId,
  Objects,
  OpEntry,
  OpEntrySansDiff,
  OpLine,
  Owner,
} from "../model.ts";
import { REJECT, REJECT_LABEL, isObjectId, isReject } from "../model.ts";
import type { LabellingPorts } from "../ports.ts";
import type {
  CreateLabelling,
  LabelCtx,
  Labelling,
  LabellingError,
  LabellingOptions,
  ObjectMatch,
  ObjectSummary,
  UnassignedQuery,
} from "../types.ts";
import { applyDiff, diffObjects, invertDiff } from "./diff.ts";
import type { StackState } from "./history.ts";
import { fold, stateOf, step, viewOf } from "./history.ts";
import type { View } from "./queries.ts";
import * as Q from "./queries.ts";

const isEmpty = (d: Diff) => Object.keys(d).length === 0;

const objectId = (n: number): ObjectId => {
  const id = `o${n}`;
  invariant(isObjectId(id), () => `bad object number ${n}`);
  return id;
};

/** Attaches `ids` to `owner`, taking them from every object first, so they end up last in its members. */
const assign = (objects: Objects, owner: Owner, ids: readonly DetId[]): Objects => {
  const moving = new Set(ids);
  return new Map(
    [...objects].map(([k, o]): [Owner, Obj] => {
      const members = o.members.filter((m) => !moving.has(m));
      return [k, { label: o.label, members: k === owner ? [...members, ...ids] : members }];
    }),
  );
};

const ownersOf = (objects: Objects): ReadonlyMap<DetId, Owner> =>
  new Map([...objects].flatMap(([k, o]) => o.members.map((m) => [m, k] as const)));

/** The highest n of the "o<n>" ids among `objects`' keys, 0 if there are none. */
const highestId = (objects: Objects): number =>
  [...objects.keys()].reduce((top, k) => {
    const m = /^o(\d+)$/.exec(k);
    return m ? Math.max(top, Number(m[1])) : top;
  }, 0);

const withoutDiff = ({ diff: _, ...e }: OpEntry): OpEntrySansDiff => e;

class LabelState implements Labelling {
  private snapshot: Objects;
  private entries: readonly OpEntry[];
  private stacks: StackState;
  private counter: number;
  private ownerIndex: ReadonlyMap<DetId, Owner>;

  constructor(
    private readonly ports: LabellingPorts,
    opts: LabellingOptions,
  ) {
    this.snapshot = opts.objects.has(REJECT)
      ? opts.objects
      : new Map([...opts.objects, [REJECT, { label: REJECT_LABEL, members: [] }]]);
    this.entries = opts.history;
    this.stacks = fold(opts.history);
    // next_obj, raised above every id in objects.json
    this.counter = Math.max(opts.nextObj, highestId(this.snapshot) + 1);
    this.ownerIndex = ownersOf(this.snapshot);
  }

  private get view(): View {
    return { objects: this.snapshot, owners: this.ownerIndex, look: this.ports.detections };
  }

  /** Persists the op, then adopts its state. */
  private commit(objects: Objects, nextObj: number, line: OpLine): ResultAsync<OpEntry, LabellingError> {
    return this.ports.log.commit({ objects, nextObj, line }).map((entry) => {
      this.snapshot = objects;
      this.counter = nextObj;
      this.entries = [...this.entries, entry];
      this.stacks = step(this.stacks, entry);
      this.ownerIndex = ownersOf(objects);
      return entry;
    });
  }

  /** An op whose diff may be empty. It is logged only if it changed something. */
  private commitChange<T>(objects: Objects, line: (d: Diff) => OpLine, reply: T): ResultAsync<T, LabellingError> {
    const d = diffObjects(this.snapshot, objects);
    return isEmpty(d) ? okAsync(reply) : this.commit(objects, this.counter, line(d)).map(() => reply);
  }

  get(id: string): Result<Obj, LabellingError> {
    return Q.owner(this.view, id).map((o) => Q.obj(this.view, o));
  }

  objectIds(): readonly ObjectId[] {
    return Q.objectIds(this.view);
  }

  ownerOf(id: DetId): Owner | undefined {
    return this.ownerIndex.get(id);
  }

  owners(): ReadonlyMap<DetId, Owner> {
    return this.ownerIndex;
  }

  rejected(): readonly DetId[] {
    return this.snapshot.get(REJECT)?.members ?? [];
  }

  summary(id: string): Result<ObjectSummary, LabellingError> {
    return Q.summary(this.view, id);
  }

  best(id: string): Result<Detection | null, LabellingError> {
    return Q.best(this.view, id);
  }

  centroid(id: string): Result<Appearance, LabellingError> {
    return Q.centroid(this.view, id);
  }

  match(ids: readonly string[], k: number, ctx: LabelCtx): Result<readonly ObjectMatch[], LabellingError> {
    return Q.match(this.view, ids, k, ctx);
  }

  unassigned(q: UnassignedQuery, ctx: LabelCtx): readonly Detection[] {
    return Q.unassigned(this.view, q, ctx);
  }

  history(): HistoryView {
    return viewOf(this.entries, this.stacks);
  }

  historyState(): HistoryState {
    return stateOf(this.entries, this.stacks);
  }

  create(
    label: string,
    ids: readonly string[],
    ctx: LabelCtx,
  ): ResultAsync<{ readonly id: ObjectId; readonly added: readonly DetId[] }, LabellingError> {
    // Skip ids already in objects.json. That only happens if someone edited the file by hand.
    const free = (n: number): number => (this.snapshot.has(objectId(n)) ? free(n + 1) : n);
    const n = free(this.counter);
    const id = objectId(n);
    // expand checks every id for no-detection before anything is created
    return this.ports.detections.expand(ids, ctx.aliasIou).asyncAndThen((added) => {
      const objects = assign(new Map([...this.snapshot, [id, { label, members: [] }]]), id, added);
      const diff = diffObjects(this.snapshot, objects);
      return this.commit(objects, n + 1, { op: "new", obj: id, label, ids: added, diff }).map(() => ({ id, added }));
    });
  }

  add(
    obj: string,
    ids: readonly string[],
    ctx: LabelCtx,
  ): ResultAsync<{ readonly added: readonly DetId[] }, LabellingError> {
    return Q.owner(this.view, obj)
      .andThen((o) => this.ports.detections.expand(ids, ctx.aliasIou).map((added) => ({ o, added })))
      .asyncAndThen(({ o, added }) =>
        this.commitChange(assign(this.snapshot, o, added), (diff) => ({ op: "add", obj: o, ids: added, diff }), {
          added,
        }),
      );
  }

  remove(
    obj: string,
    ids: readonly string[],
    ctx: LabelCtx,
  ): ResultAsync<{ readonly removed: readonly DetId[] }, LabellingError> {
    return Q.owner(this.view, obj)
      .andThen((o) => this.ports.detections.expand(ids, ctx.aliasIou).map((removed) => ({ o, removed })))
      .asyncAndThen(({ o, removed }) => {
        const gone = new Set(removed);
        const objects = new Map(
          [...this.snapshot].map(([k, x]): [Owner, Obj] =>
            k === o ? [k, { label: x.label, members: x.members.filter((m) => !gone.has(m)) }] : [k, x],
          ),
        );
        return this.commitChange(objects, (diff) => ({ op: "remove", obj: o, ids: removed, diff }), { removed });
      });
  }

  merge(into: string, from: string): ResultAsync<void, LabellingError> {
    if (isReject(into) || isReject(from)) return errAsync({ kind: "merge-reject" });
    if (into === from) return errAsync({ kind: "merge-self" });
    const v = this.view;
    return Q.realObject(v, into)
      .andThen((a) => Q.realObject(v, from).map((b) => ({ a, b })))
      .asyncAndThen(({ a, b }) => {
        const oa = Q.obj(v, a),
          ob = Q.obj(v, b);
        const had = new Set(oa.members);
        const merged: Obj = { label: oa.label, members: [...oa.members, ...ob.members.filter((m) => !had.has(m))] };
        const objects = new Map(
          [...this.snapshot].flatMap(([k, x]): [Owner, Obj][] => (k === b ? [] : [[k, k === a ? merged : x]])),
        );
        const diff = diffObjects(this.snapshot, objects);
        return this.commit(objects, this.counter, { op: "merge", into: a, from: b, diff }).map(() => undefined);
      });
  }

  relabel(obj: string, label: string): ResultAsync<void, LabellingError> {
    return Q.owner(this.view, obj).asyncAndThen((o) => {
      const objects = new Map(
        [...this.snapshot].map(([k, x]): [Owner, Obj] => (k === o ? [k, { label, members: x.members }] : [k, x])),
      );
      return this.commitChange(objects, (diff) => ({ op: "label", obj: o, label, diff }), undefined);
    });
  }

  delete(obj: string): ResultAsync<void, LabellingError> {
    if (isReject(obj)) return errAsync({ kind: "delete-reject" });
    return Q.realObject(this.view, obj).asyncAndThen((o) => {
      const objects = new Map([...this.snapshot].filter(([k]) => k !== o));
      const diff = diffObjects(this.snapshot, objects);
      return this.commit(objects, this.counter, { op: "delete", obj: o, diff }).map(() => undefined);
    });
  }

  reject(ids: readonly string[], ctx: LabelCtx): ResultAsync<{ readonly rejected: readonly DetId[] }, LabellingError> {
    return this.ports.detections.expand(ids, ctx.aliasIou).asyncAndThen((rejected) =>
      this.commitChange(assign(this.snapshot, REJECT, rejected), (diff) => ({ op: "reject", ids: rejected, diff }), {
        rejected,
      }),
    );
  }

  undo(): ResultAsync<{ readonly undone: OpEntrySansDiff } & HistoryState, LabellingError> {
    const top = this.stacks.undo;
    if (top === null) return errAsync({ kind: "nothing-to-undo" });
    return this.replay("undo", top.top, invertDiff).map((undone) => ({ undone, ...this.historyState() }));
  }

  redo(): ResultAsync<{ readonly redone: OpEntrySansDiff } & HistoryState, LabellingError> {
    const top = this.stacks.redo;
    if (top === null) return errAsync({ kind: "nothing-to-redo" });
    return this.replay("redo", top.top, (d) => d).map((redone) => ({ redone, ...this.historyState() }));
  }

  private replay(
    op: "undo" | "redo",
    seq: number,
    how: (d: Diff) => Diff,
  ): ResultAsync<OpEntrySansDiff, LabellingError> {
    const entry = this.entries[seq];
    // the stacks hold only entries with a diff
    invariant(entry !== undefined && entry.diff !== undefined, () => `history entry ${seq} has no diff`);
    const d = how(entry.diff);
    return applyDiff(this.snapshot, d)
      .mapErr((reason): LabellingError => ({ kind: "cannot-replay", op, seq, of: entry.op, reason }))
      .asyncAndThen((objects) => this.commit(objects, this.counter, { op, of: seq, diff: d }))
      .map(() => withoutDiff(entry));
  }

  stripFrames(clip: {
    readonly key: ClipKey;
    readonly path: string;
    readonly frames: readonly [FrameNo, ...FrameNo[]];
  }): ResultAsync<{ readonly stripped: number; readonly deleted: readonly ObjectId[] }, LabellingError> {
    const inClip = new Set(this.ports.detections.inFrames(new Set(clip.frames)).map((d) => d.id));
    const rows = [...this.snapshot].map(([k, o]) => {
      const keep = o.members.filter((m) => !inClip.has(m));
      const changed = keep.length !== o.members.length;
      return {
        k,
        o: { label: o.label, members: keep },
        lost: o.members.length - keep.length,
        gone: changed && !keep.length && isObjectId(k),
      };
    });
    const deleted = rows.flatMap((r) => (r.gone && isObjectId(r.k) ? [r.k] : []));
    const stripped = rows.reduce((s, r) => s + r.lost, 0);
    const objects: Objects = new Map(
      rows.filter((r) => !r.gone).map((r) => [r.k, r.lost ? r.o : Q.obj(this.view, r.k)] as const),
    );
    const changes = diffObjects(this.snapshot, objects);
    const first = clip.frames[0];
    const last = clip.frames.at(-1) ?? first;
    // Log the line even if no object held the clip's detections, because it is the history barrier. An earlier op
    // may have touched them, and undoing it now would bring back the deleted detections.
    return this.commit(objects, this.counter, {
      op: "clip_remove",
      clip: clip.key,
      path: clip.path,
      frames: [first, last],
      deleted,
      changes,
    }).map(() => ({ stripped, deleted }));
  }
}

export const createLabelling: CreateLabelling = (ports, opts) => new LabelState(ports, opts);
