/** In-memory LabelLog. Tests use the real createDetections as DetectionLookup, so no fake of it can drift. */
import { errAsync, okAsync } from "neverthrow";
import type {
  Commit,
  DetectionLookup,
  LabelLog,
  Labelling,
  LabellingOptions,
  Objects,
  OpEntry,
} from "../../src/labelling/index.ts";
import { createLabelling } from "../../src/labelling/index.ts";
import type { HostFailure } from "../../src/ports/index.ts";

export class MemLabelLog implements LabelLog {
  entries: OpEntry[];
  /** objects.json as last committed (empty until the first commit). */
  objects: Objects = new Map();
  /** next_obj as last committed (1 before the first commit). */
  nextObj = 1;
  commits: Commit[] = [];
  /** Fail the next commit as a host failure would, with nothing persisted. */
  failNext = false;
  ts = 1000;

  constructor(history: readonly OpEntry[] = []) {
    this.entries = [...history];
  }

  commit(c: Commit) {
    if (this.failNext) {
      this.failNext = false;
      const f: HostFailure = { kind: "host", port: "store", op: "appendText", message: "disk full" };
      return errAsync(f);
    }
    this.commits.push(c);
    this.objects = c.objects;
    this.nextObj = c.nextObj;
    this.ts += 1.5;
    const entry: OpEntry = { ts: this.ts, ...c.line, seq: this.entries.length };
    this.entries.push(entry);
    return okAsync(entry);
  }
}

export type Opened = { lab: Labelling; log: MemLabelLog };

export function open(
  detections: DetectionLookup,
  opts: Partial<LabellingOptions> = {},
  log = new MemLabelLog(opts.history ?? []),
): Opened {
  const lab = createLabelling(
    { detections, log },
    { objects: opts.objects ?? new Map(), history: opts.history ?? [...log.entries], nextObj: opts.nextObj ?? 1 },
  );
  return { lab, log };
}

/** Reopen from what the log persisted (objects.json, ops.jsonl, session.json next_obj). */
export function reopen(detections: DetectionLookup, log: MemLabelLog): Opened {
  return open(detections, { objects: log.objects, history: [...log.entries], nextObj: log.nextObj }, log);
}
