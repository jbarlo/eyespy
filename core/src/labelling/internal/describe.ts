/**
 * One history entry as a line of text, for the web History panel. Entries come from ops.jsonl as stored, so their
 * shape is open. Zod parses the known ops into the OpLine fields they show.
 */
import { z } from "zod";

const ids = z.array(z.string()).optional();
const KNOWN = z.discriminatedUnion("op", [
  z.object({ op: z.literal("new"), obj: z.string(), label: z.string(), ids }),
  z.object({ op: z.literal("add"), obj: z.string(), ids }),
  z.object({ op: z.literal("remove"), obj: z.string(), ids }),
  z.object({ op: z.literal("merge"), from: z.string(), into: z.string() }),
  z.object({ op: z.literal("label"), obj: z.string(), label: z.string() }),
  z.object({ op: z.literal("delete"), obj: z.string() }),
  z.object({ op: z.literal("reject"), ids }),
  z.object({
    op: z.literal("clip_remove"),
    path: z.string().optional(),
    clip: z.string().optional(),
    frames: z.array(z.number()).optional(),
  }),
  z.object({ op: z.literal("undo"), of: z.number() }),
  z.object({ op: z.literal("redo"), of: z.number() }),
]);

const count = (list: readonly string[] | undefined): string =>
  list ? ` ${list.length} det${list.length === 1 ? "" : "s"}` : "";

/**
 * Lines such as "new o3 “jar” 2 dets", "merge o2 into o1", "remove video a.mp4 (#0–#12)" and "undo #5". An entry
 * that doesn't parse gives just the op name.
 */
export const describeOp = (entry: { readonly op: string; readonly [k: string]: unknown }): string => {
  const parsed = KNOWN.safeParse(entry);
  if (!parsed.success) return entry.op;
  const e = parsed.data;
  switch (e.op) {
    case "new":
      return `new ${e.obj} “${e.label}”${count(e.ids)}`;
    case "add":
      return `add${count(e.ids)} to ${e.obj}`;
    case "remove":
      return `remove${count(e.ids)} from ${e.obj}`;
    case "merge":
      return `merge ${e.from} into ${e.into}`;
    case "label":
      return `rename ${e.obj} “${e.label}”`;
    case "delete":
      return `delete ${e.obj}`;
    case "reject":
      return `reject${count(e.ids)}`;
    case "clip_remove":
      return `remove video ${(e.path ?? e.clip ?? "").split("/").at(-1)} (#${(e.frames ?? []).join("–#")})`;
    case "undo":
      return `undo #${e.of}`;
    case "redo":
      return `redo #${e.of}`;
  }
};
