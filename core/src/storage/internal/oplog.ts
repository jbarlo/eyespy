/**
 * Parses ops.jsonl, accepting bad lines, and encodes it with stable bytes.
 *
 * Parsing gives one entry per non-empty line, with `seq` its index among them. A line that isn't a JSON object
 * becomes the barrier `{op: "?"}`. Any other line keeps every field it has, even ones no OpLine declares (a
 * hand-edited line, say). The exception is a typed field (`ts`, `of`, `diff`, `changes`) with the wrong shape,
 * which is left out, so a line whose diff can't be read is never a crash at undo time.
 *
 * Encoding writes `{"ts": <clock s>, ...}` with lineJson's separators. The OpLine's keys follow the order
 * labelling's union declares, whatever order the object was built in. Each Change's keys are from, to, add,
 * remove.
 */
import { z } from "zod";
import type { DetId } from "../../detections/pure.ts";
import { isDetId } from "../../detections/pure.ts";
import type { Change, Diff, OpEntry, OpLine } from "../../labelling/pure.ts";
import { parseJson } from "../../railway/index.ts";
import { isObject, lineJson } from "./json.ts";

const detId = z.custom<DetId>((v) => typeof v === "string" && isDetId(v));
const ChangeSchema = z.object({
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  add: z.array(detId).optional(),
  remove: z.array(detId).optional(),
});
const DiffSchema = z.record(z.string(), ChangeSchema);
const TYPED: Readonly<Record<string, z.ZodType>> = {
  ts: z.number(),
  of: z.number().int(),
  diff: DiffSchema,
  changes: DiffSchema,
};

const entryOf = (v: unknown, seq: number): OpEntry => {
  if (!isObject(v)) return { op: "?", seq };
  const fields = Object.entries(v).filter(([k, x]) => TYPED[k]?.safeParse(x).success ?? true);
  // The filter above checked each field, and this is the decoding edge, so the cast is safe.
  return {
    ...(Object.fromEntries(fields) as Omit<OpEntry, "op" | "seq">),
    op: typeof v.op === "string" ? v.op : "?",
    seq,
  };
};

/** Parses ops.jsonl text into entries, with the typed-field checks. */
export const parseLog = (text: string): readonly OpEntry[] =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, seq) => entryOf(parseJson(line).unwrapOr(null), seq));

type FieldsOf<K extends OpLine["op"]> = readonly (keyof Extract<OpLine, { op: K }> & string)[];
const OP_FIELDS: { readonly [K in OpLine["op"]]: FieldsOf<K> } = {
  new: ["op", "obj", "label", "ids", "diff"],
  add: ["op", "obj", "ids", "diff"],
  remove: ["op", "obj", "ids", "diff"],
  merge: ["op", "into", "from", "diff"],
  label: ["op", "obj", "label", "diff"],
  delete: ["op", "obj", "diff"],
  reject: ["op", "ids", "diff"],
  undo: ["op", "of", "diff"],
  redo: ["op", "of", "diff"],
  clip_remove: ["op", "clip", "path", "frames", "deleted", "changes"],
};

const orderChange = (c: Change): Change => ({
  ...("from" in c ? { from: c.from } : {}),
  ...("to" in c ? { to: c.to } : {}),
  ...(c.add !== undefined ? { add: c.add } : {}),
  ...(c.remove !== undefined ? { remove: c.remove } : {}),
});
const orderDiff = (d: Diff): Diff => Object.fromEntries(Object.entries(d).map(([k, c]) => [k, orderChange(c)]));

/** The line's fields in byte order, `ts` first, and the entry they make with `seq`. */
export function encodeLine(line: OpLine, ts: number, seq: number): { readonly text: string; readonly entry: OpEntry } {
  const ordered: OpLine =
    "diff" in line ? { ...line, diff: orderDiff(line.diff) } : { ...line, changes: orderDiff(line.changes) };
  const given = new Map<string, unknown>(Object.entries(ordered));
  const order: readonly string[] = OP_FIELDS[line.op];
  const keys = [...order.filter((k) => given.has(k)), ...[...given.keys()].filter((k) => !order.includes(k))];
  const obj = Object.fromEntries([["ts", ts], ...keys.map((k) => [k, given.get(k)] as const)]);
  return { text: lineJson(obj) + "\n", entry: { ...(obj as Omit<OpEntry, "op" | "seq">), op: line.op, seq } };
}
