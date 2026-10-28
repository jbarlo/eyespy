/** The op table. Hosts import `OPS` as a value without pulling in tRPC and derive their op lists from it. */

export type OpKind = "query" | "mutation";

/** Every procedure and its kind, in the order hosts list them. `data.*` ops are queries and the rest are mutations. */
const KINDS = {
  status: "mutation",
  add: "mutation",
  "clips.list": "mutation",
  "clips.remove": "mutation",
  config: "mutation",
  sheet: "mutation",
  find: "mutation",
  search: "mutation",
  semantic: "mutation",
  show: "mutation",
  crop: "mutation",
  similar: "mutation",
  dets: "mutation",
  "obj.new": "mutation",
  "obj.add": "mutation",
  "obj.remove": "mutation",
  "obj.merge": "mutation",
  "obj.label": "mutation",
  "obj.delete": "mutation",
  "obj.show": "mutation",
  "obj.suggest": "mutation",
  "obj.match": "mutation",
  reject: "mutation",
  todo: "mutation",
  features: "mutation",
  undo: "mutation",
  redo: "mutation",
  gaps: "mutation",
  manifest: "mutation",
  shutdown: "mutation",
  "data.frames": "query",
  "data.dets": "query",
  "data.runs": "query",
  "data.objects": "query",
  "data.history": "query",
} as const satisfies Readonly<Record<string, OpKind>>;

export type OpPath = keyof typeof KINDS;
export type OpSpec = { readonly path: OpPath; readonly kind: OpKind };

export const isOpPath = (s: string): s is OpPath => Object.hasOwn(KINDS, s);
export const opKind = (p: OpPath): OpKind => KINDS[p];

/** Every op, in KINDS order. */
export const OPS: readonly OpSpec[] = Object.keys(KINDS)
  .filter(isOpPath)
  .map((path) => ({ path, kind: KINDS[path] }));
