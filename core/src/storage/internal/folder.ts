/**
 * The consumers' ports over one SessionStore. `open()` sets the adapter state (session.json's two parts, ops.jsonl
 * line count) and must run first. A write to session.json or ops.jsonl before it fails an invariant.
 */
import type { Result } from "neverthrow";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { DetId, Detection, HeatmapRef, RunRecord } from "../../detections/pure.ts";
import { invariant } from "../../invariant/index.ts";
import type { Commit, LabelLog } from "../../labelling/ports.ts";
import type { Clock, HostFailure, SessionStore } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import type { DetectionStore, HeatmapStore, MetaStore, OutputSink, SessionMeta } from "../../session/ports.ts";
import type { ClipKey, FrameNo, FrameRef } from "../../video/pure.ts";
import type { StoragePorts } from "../ports.ts";
import type { FeatureFiles, FrameFiles, SessionFolder, SessionRecords, StorageError } from "../types.ts";
import { parseJson } from "../../railway/index.ts";
import { jsonText } from "./json.ts";
import {
  KEYS,
  clipDir,
  detKey,
  featDir,
  featIndex,
  featKey,
  frameKey,
  heatmapName,
  maskKey,
  outKey,
  semKey,
} from "./keys.ts";
import { decodeMetaText, metaText } from "./meta.ts";
import { encodeLine, parseLog } from "./oplog.ts";
import type { DetMeta } from "./records.ts";
import {
  decodeDetIndex,
  decodeDetection,
  decodeObjects,
  decodeRuns,
  encodeDetIndex,
  encodeDetection,
  encodeObjects,
  encodeRuns,
} from "./records.ts";

/** Wraps a host call, so a rejection or a synchronous throw becomes a HostFailure. */
const host = <T>(op: string, f: () => Promise<T>): ResultAsync<T, HostFailure> =>
  ResultAsync.fromPromise(Promise.resolve().then(f), (e) => hostFailure("store", op, e));

class Folder implements SessionFolder {
  /** session.json as last read or written: the session part and the object counter. */
  private saved: { readonly meta: SessionMeta; readonly nextObj: number } | null = null;
  private seq: number | null = null;
  /** ops.jsonl doesn't end with a newline (a hand-edited or truncated file), so the next line starts with one. */
  private needsNewline = false;

  readonly root: string;
  private readonly store: SessionStore;
  private readonly clock: Clock;

  constructor(ports: StoragePorts) {
    this.store = ports.store;
    this.clock = ports.clock;
    this.root = ports.store.root;
  }

  private readonly text = (key: string): ResultAsync<string | null, HostFailure> =>
    host("readText", () => this.store.readText(key));
  private readonly writeText = (key: string, text: string): ResultAsync<void, HostFailure> =>
    host("writeText", () => this.store.writeText(key, text));
  private readonly bytes = (key: string): ResultAsync<Uint8Array | null, HostFailure> =>
    host("read", () => this.store.read(key));
  private readonly writeBytes = (key: string, b: Uint8Array): ResultAsync<void, HostFailure> =>
    host("write", () => this.store.write(key, b));
  private readonly exists = (key: string): ResultAsync<boolean, HostFailure> =>
    host("exists", () => this.store.exists(key));
  private readonly remove = (key: string): ResultAsync<void, HostFailure> =>
    host("remove", () => this.store.remove(key));
  private readonly size = (key: string): ResultAsync<number | null, HostFailure> =>
    host("size", () => this.store.size(key));

  open(): ResultAsync<SessionRecords, StorageError> {
    const json = <T>(
      key: string,
      empty: string,
      decode: (v: unknown) => Result<T, StorageError>,
    ): ResultAsync<T, StorageError> =>
      this.text(key).andThen((t) =>
        parseJson(t ?? empty)
          .mapErr((message): StorageError => ({ kind: "bad-record", file: key, message }))
          .andThen(decode),
      );
    return this.text(KEYS.session)
      .andThen((t) =>
        t === null ? errAsync<string, StorageError>({ kind: "no-session", root: this.root }) : okAsync(t),
      )
      .andThen((t) => decodeMetaText(t))
      .andThen((meta) =>
        ResultAsync.combine([
          json(KEYS.runs, "{}", decodeRuns),
          json(KEYS.objects, "{}", decodeObjects),
          this.text(KEYS.ops),
          json(KEYS.dets, "[]", decodeDetIndex).andThen((metas) => this.loadDetections(metas)),
        ] as const).map(([runs, objects, ops, dets]): SessionRecords => {
          const history = parseLog(ops ?? "");
          // A new session's session.json has no next_obj yet. Its counter starts at 1, written with the next save.
          const nextObj = meta.nextObj ?? 1;
          this.saved = { meta: meta.meta, nextObj };
          this.seq = history.length;
          this.needsNewline = ops !== null && ops.length > 0 && !ops.endsWith("\n");
          return {
            meta: meta.meta,
            nextObj,
            detections: dets,
            runs,
            objects,
            history,
          };
        }),
      );
  }

  private loadDetections(metas: readonly DetMeta[]): ResultAsync<readonly Detection[], StorageError> {
    return ResultAsync.combine(
      metas.map((m) =>
        this.bytes(detKey(m.id)).andThen((b) =>
          b === null
            ? errAsync<Detection, StorageError>({ kind: "missing-detection-file", id: m.id })
            : decodeDetection(m, b),
        ),
      ),
    );
  }

  private stored(): { readonly meta: SessionMeta; readonly nextObj: number } {
    const saved = this.saved;
    invariant(saved !== null, "storage: session.json written before open()");
    return saved;
  }

  private saveMeta(meta: SessionMeta, nextObj: number): ResultAsync<void, HostFailure> {
    return this.writeText(KEYS.session, metaText(meta, nextObj)).map(() => {
      this.saved = { meta, nextObj };
    });
  }

  readonly meta: MetaStore = {
    write: (meta: SessionMeta) => this.saveMeta(meta, this.stored().nextObj),
  };

  readonly frames: FrameFiles = {
    read: (r: FrameRef) => this.bytes(frameKey(r)),
    write: (r: FrameRef, jpeg: Uint8Array) => this.writeBytes(frameKey(r), jpeg),
    has: (r: FrameRef) => this.exists(frameKey(r)),
    size: (r: FrameRef) => this.size(frameKey(r)),
    locate: (r: FrameRef) => this.store.locate(frameKey(r)),
  };

  readonly features: FeatureFiles = {
    read: (r: FrameRef) => this.bytes(featKey(r)),
    write: (r: FrameRef, b: Uint8Array) => this.writeBytes(featKey(r), b),
    has: (r: FrameRef) => this.exists(featKey(r)),
    remove: (r: FrameRef) => this.remove(featKey(r)),
    size: (r: FrameRef) => this.size(featKey(r)),
    list: (clipKey: ClipKey) =>
      host("list", () => this.store.list(featDir(clipKey))).map((files) =>
        files.flatMap((f) => {
          const index = featIndex(f.name);
          return index === null ? [] : [{ ref: { clipKey, index }, bytes: f.size, mtime: f.mtime }];
        }),
      ),
  };

  readonly detections: DetectionStore = {
    writeDetection: (d: Detection) => this.writeBytes(detKey(d.id), encodeDetection(d, this.clock.now())),
    removeDetection: (id: DetId) => this.remove(detKey(id)).andThen(() => this.remove(maskKey(id))),
    writeIndex: (ds: readonly Detection[], runs: readonly RunRecord[]) =>
      this.writeText(KEYS.dets, jsonText(encodeDetIndex(ds))).andThen(() =>
        this.writeText(KEYS.runs, jsonText(encodeRuns(runs))),
      ),
    maskImage: (id: DetId) => this.exists(maskKey(id)).map((has) => (has ? this.store.locate(maskKey(id)) : null)),
    writeMaskImage: (id: DetId, png: Uint8Array) =>
      this.writeBytes(maskKey(id), png).map(() => this.store.locate(maskKey(id))),
  };

  readonly labels: LabelLog = {
    commit: (c: Commit) => {
      const saved = this.stored();
      const seq = this.seq;
      invariant(seq !== null, "storage: ops.jsonl appended before open()");
      // next_obj (if changed), then objects.json, then the op line. A crash in between can skip an object id or leave
      // objects.json ahead of the log. It never reuses an id or logs a change that isn't saved.
      const counter = saved.nextObj === c.nextObj ? okAsync(undefined) : this.saveMeta(saved.meta, c.nextObj);
      const { text, entry } = encodeLine(c.line, this.clock.now() / 1000, seq);
      return counter
        .andThen(() => this.writeText(KEYS.objects, jsonText(encodeObjects(c.objects))))
        .andThen(() =>
          host("appendText", () => this.store.appendText(KEYS.ops, (this.needsNewline ? "\n" : "") + text)),
        )
        .map(() => {
          this.seq = seq + 1;
          this.needsNewline = false;
          return entry;
        });
    },
  };

  readonly heatmaps: HeatmapStore = {
    write: (frame: FrameNo, prompt: string, png: Uint8Array) =>
      // Hashing the prompt is a crypto.subtle digest of bytes, not a store call, and does not fail.
      ResultAsync.fromSafePromise(heatmapName(frame, prompt)).andThen((ref) =>
        this.writeBytes(semKey(ref), png).map(() => ref),
      ),
    read: (ref: HeatmapRef) => this.bytes(semKey(ref)),
    remove: (ref: HeatmapRef) => this.remove(semKey(ref)),
    locate: (ref: HeatmapRef) => this.store.locate(semKey(ref)),
  };

  readonly outputs: OutputSink = {
    writeImage: (name: string, jpeg: Uint8Array) =>
      this.writeBytes(outKey(name), jpeg).map(() => this.store.locate(outKey(name))),
  };

  removeClipFiles(key: ClipKey): ResultAsync<void, HostFailure> {
    return host("removeDir", () => this.store.removeDir(clipDir(key)));
  }
}

export const createSessionFolder = (ports: StoragePorts): SessionFolder => new Folder(ports);
