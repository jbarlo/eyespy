/** The tRPC router has one procedure per op, and each runs on the engine's actor. Zod failures give BAD_REQUEST. */
import { initTRPC } from "@trpc/server";
import type { ResultAsync } from "neverthrow";
import { z } from "zod";
import type { Ctx, Session, SessionError } from "../session/index.ts";
import { toTRPCError } from "./errors.ts";
import type { Context, OpIo, WithCfg } from "./types.ts";

const t = initTRPC.context<Context>().create();

const cfg = z.record(z.string(), z.number()).optional();
/** A frame spec as typed ("3-10,15") or one frame number. Null or absent means every frame. */
const frames = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? undefined : String(v)));
const hold = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? undefined : String(v)));
const threshold = z.number().nullish();
const crops = z.boolean().nullish();
const flag = z.boolean().nullish();
const text = z.string().nullish();
const ids = z.array(z.string()).min(1).readonly();
const k = z.number().int().positive().nullish();
/** x0, y0, x1, y1 in full-res pixels. */
const box4 = z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly();
const offset = z.number().int().nonnegative().nullish();
/** A feature disk budget in MB, or "unlimited". */
const diskBudget = z.union([z.number().int().nonnegative(), z.literal("unlimited")]).nullish();

/** Unwraps a session result for tRPC. Ok returns the reply. Err throws the mapped TRPCError, as tRPC requires. */
const settle = async <T>(r: ResultAsync<T, SessionError>): Promise<T> =>
  (await r).match(
    (v) => v,
    (e) => {
      throw toTRPCError(e);
    },
  );

type Run<I, R> = (s: Session, ctx: Ctx, input: I) => ResultAsync<R, SessionError>;
type Out<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;
/** zod types an empty object's input as Record<string, never>, which would forbid `cfg`. It only means "no fields". */
type In<S extends z.ZodRawShape> = keyof S extends never ? Record<never, never> : z.input<z.ZodObject<S>>;

function op<S extends z.ZodRawShape, R>(shape: S, run: Run<Out<S>, R>) {
  // zod can't type `extend` over a generic shape. The cast states what extend({ cfg }) produces.
  const schema = z.object(shape).extend({ cfg }) as unknown as z.ZodType<Out<S> & WithCfg, In<S> & WithCfg>;
  return t.procedure.input(schema).mutation(({ ctx, input }) => {
    const i = input as Out<S> & WithCfg; // tRPC's input type stays unresolved over a generic schema
    return settle(ctx.engine.call(i.cfg, (s, c) => run(s, c, i)));
  });
}

function read<S extends z.ZodRawShape, R>(shape: S, run: Run<Out<S>, R>) {
  const schema = z.object(shape) as unknown as z.ZodType<Out<S>, In<S>>;
  return t.procedure.input(schema.optional()).query(({ ctx, input }) => {
    const i = (input ?? schema.parse({})) as Out<S>;
    return settle(ctx.engine.call(undefined, (s, c) => run(s, c, i)));
  });
}

export const appRouter = t.router({
  /** Raw per-frame data for interactive UIs (draw your own overlays instead of rendered sheets). */
  data: t.router({
    frames: read({}, (s, c) => s.data.frames(c, {})),
    dets: read(
      { frames, prompt: text, threshold, mask: z.enum(["rle", "png", "none"]).nullish(), aliases: flag },
      (s, c, i) => s.data.dets(c, i),
    ),
    runs: read({ frames, prompt: text }, (s, c, i) => s.data.runs(c, i)),
    objects: read({}, (s, c) => s.data.objects(c, {})),
    /** ops.jsonl, oldest first, with undo state. */
    history: read({}, (s, c) => s.data.history(c, {})),
  }),
  status: op({}, (s, c) => s.videos.status(c, {})),
  add: op({ video: z.string(), fps: z.number().positive().max(1000).nullish() }, (s, c, i) => s.videos.add(c, i)),
  /** The session's videos. Removing one leaves a tombstone, so its frame indices stay reserved. */
  clips: t.router({
    list: op({ all: flag }, (s, c, i) => s.videos.list(c, i)),
    remove: op({ clip: z.string().min(1) }, (s, c, i) => s.videos.remove(c, i)),
  }),
  config: op({ key: text, value: z.union([z.string(), z.number()]).nullish() }, (s, c, i) => s.videos.config(c, i)),
  sheet: op({ frames }, (s, c, i) => s.find.sheet(c, i)),
  find: op({ prompt: z.string().min(1), frames, crops, threshold, hold }, (s, c, i) => s.find.find(c, i)),
  /** Crop-based region search (prompt and/or DINOv2 similarity). */
  search: op({ frame: z.number().int(), box: box4, prompt: text, similar: flag, k, threshold }, (s, c, i) =>
    s.find.search(c, i),
  ),
  semantic: op({ prompt: z.string().min(1), frames, uncovered: flag, hold }, (s, c, i) => s.find.semantic(c, i)),
  show: op({ frames, crops, threshold, objects: flag, rejects: flag }, (s, c, i) => s.look.show(c, i)),
  crop: op({ id: z.string() }, (s, c, i) => s.look.crop(c, i)),
  similar: op({ id: z.string(), k, threshold }, (s, c, i) => s.look.similar(c, i)),
  dets: op({ frames, crops, threshold, prompt: text }, (s, c, i) => s.look.dets(c, i)),
  obj: t.router({
    new: op({ label: z.string(), ids }, (s, c, i) => s.label.create(c, i)),
    add: op({ obj: z.string(), ids }, (s, c, i) => s.label.add(c, i)),
    remove: op({ obj: z.string(), ids }, (s, c, i) => s.label.remove(c, i)),
    merge: op({ into: z.string(), from: z.string() }, (s, c, i) => s.label.merge(c, i)),
    label: op({ obj: z.string(), label: z.string() }, (s, c, i) => s.label.relabel(c, i)),
    delete: op({ obj: z.string() }, (s, c, i) => s.label.delete(c, i)),
    show: op({ obj: z.string(), frames, offset }, (s, c, i) => s.label.show(c, i)),
    suggest: op({ obj: z.string(), k, threshold }, (s, c, i) => s.label.suggest(c, i)),
    /** Ranks existing objects against detections ("which object is this?"). */
    match: op({ ids, k }, (s, c, i) => s.label.match(c, i)),
  }),
  reject: op({ ids: z.array(z.string()).readonly().nullish(), prompt: text }, (s, c, i) => s.label.reject(c, i)),
  todo: op(
    { crops, threshold, prompt: text, limit: z.number().int().positive().nullish(), frames, groups: flag, offset },
    (s, c, i) => s.label.todo(c, i),
  ),
  /**
   * Vision-feature storage. Turns persisting on or off, sets this engine's disk budget, clears stored features (all,
   * or one clip's) and reports counts.
   */
  features: op({ persist: flag, clear: flag, clip: text, diskMB: diskBudget }, (s, c, i) => s.videos.features(c, i)),
  /** Reverts the latest undoable object op, using its diff in ops.jsonl. */
  undo: op({}, (s, c) => s.label.undo(c, {})),
  redo: op({}, (s, c) => s.label.redo(c, {})),
  gaps: op({ frames }, (s, c, i) => s.look.gaps(c, i)),
  manifest: op({ crops }, (s, c, i) => s.export.manifest(c, i)),
  shutdown: t.procedure.mutation(({ ctx }) => {
    setTimeout(() => ctx.engine.shutdown(), 50); // send the reply first
    return { ok: true as const };
  }),
});

export type AppRouter = typeof appRouter;

/** An in-process caller for transports other than HTTP, such as the browser worker's postMessage server. */
export const createCaller = t.createCallerFactory(appRouter);

type Procedures = typeof appRouter._def.procedures;
type At<R, P extends string> = P extends `${infer H}.${infer Rest}`
  ? H extends keyof R
    ? At<R[H], Rest>
    : never
  : P extends keyof R
    ? R[P]
    : never;
type ProcOut<P> = P extends { _def: { $types: { output: infer O } } } ? O : never;
type ProcIn<P> = P extends { _def: { $types: { input: infer I } } } ? I : never;
type Agrees = {
  readonly [P in keyof OpIo]: [ProcOut<At<Procedures, P>>] extends [OpIo[P]["out"]]
    ? [OpIo[P]["in"]] extends [ProcIn<At<Procedures, P>>]
      ? true
      : { readonly input: P }
    : { readonly output: P };
};
type Disagreement = { readonly [P in keyof Agrees]: Agrees[P] extends true ? never : Agrees[P] }[keyof Agrees];
/** Fails to type-check, naming the op, when a procedure's output or accepted input disagrees with OpIo. */
const _routerAgreesWithOpIo: [Disagreement] extends [never] ? true : Disagreement = true;
