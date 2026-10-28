/**
 * session.json's schema, version check, decoding and encoding. The file holds two parts: MetaStore's session part
 * and LabelLog's next_obj. Encoding writes every field from those two parts, keys in a fixed order, and leaves out
 * absent optional fields. Decoding ignores keys it doesn't know, so a save drops them.
 *
 * Clip fields map to the domain like this:
 *   - `removed` (seconds, 3 decimals) is `clip.removed.at`.
 *   - `next_n` ({frame: counter}) is `clip.reserved` on every clip, removed or not. An empty one is not written.
 *   - `fps` or `stills: true` is `clip.timing`. Neither means a video file (the web app's clips).
 */
import { Result, err, ok } from "neverthrow";
import { z } from "zod";
import type { Config } from "../../session/pure.ts";
import { CONFIG_KEYS, DEFAULT_CONFIG } from "../../session/pure.ts";
import type { SessionMeta } from "../../session/ports.ts";
import type { Clip, ClipKey, ClipTiming, FrameNo } from "../../video/pure.ts";
import { isClipKey, isFrameNo } from "../../video/pure.ts";
import type { StorageError } from "../types.ts";
import { parseJson } from "../../railway/index.ts";
import { issues, jsonText } from "./json.ts";

/** The only version this code reads and writes. */
const SESSION_VERSION = 1;

const clipKey = z.custom<ClipKey>((v) => typeof v === "string" && isClipKey(v), "not a clip key (12 hex digits)");
const ClipSchema = z.object({
  path: z.string(),
  key: clipKey,
  times: z.array(z.number()),
  fps: z.number().positive().optional(),
  stills: z.literal(true).optional(),
  shape: z.tuple([z.number(), z.number()]),
  captured: z.string().nullable().optional(),
  keyframe_thresh: z.number().nullable().optional(),
  removed: z.number().nullable().optional(),
  next_n: z.record(z.string().regex(/^\d+$/), z.number()).optional(),
});
const MetaSchema = z.object({
  version: z.number(),
  config: z.record(z.string(), z.unknown()).optional(),
  clips: z.array(z.unknown()),
  next_obj: z.number().int().optional(),
  features: z.string().optional(),
});

/** Decoded session.json: the session part and next_obj. */
export type DecodedMeta = {
  readonly meta: SessionMeta;
  readonly nextObj: number | null;
};

const counters = (nextN: Readonly<Record<string, number>> | undefined): ReadonlyMap<FrameNo, number> =>
  new Map(
    Object.entries(nextN ?? {}).flatMap(([f, n]) => {
      const i = Number(f);
      return isFrameNo(i) ? [[i, n] as const] : [];
    }),
  );

const decodeConfig = (raw: Readonly<Record<string, unknown>>): Result<Partial<Config>, StorageError> => {
  const bad = CONFIG_KEYS.find((k) => Object.hasOwn(raw, k) && typeof raw[k] !== "number");
  if (bad !== undefined) return err({ kind: "bad-session-json", message: `config.${bad}: not a number` });
  return ok(Object.fromEntries(CONFIG_KEYS.flatMap((k) => (typeof raw[k] === "number" ? [[k, raw[k]]] : []))));
};

const decodeClip = (v: unknown, k: number): Result<Clip, StorageError> => {
  const c = ClipSchema.safeParse(v);
  if (!c.success) return err({ kind: "bad-session-json", message: `clips.${k}: ${issues(c.error)}` });
  const d = c.data;
  if (d.fps !== undefined && d.stills)
    return err({ kind: "bad-session-json", message: `clips.${k}: both fps and stills` });
  const timing: ClipTiming =
    d.fps !== undefined ? { kind: "rate", fps: d.fps } : d.stills ? { kind: "stills" } : { kind: "video" };
  return ok({
    path: d.path,
    key: d.key,
    times: d.times,
    timing,
    shape: d.shape,
    captured: d.captured ?? null,
    keyframeThresh: d.keyframe_thresh ?? null,
    removed: d.removed === undefined || d.removed === null ? null : { at: d.removed },
    reserved: counters(d.next_n),
  });
};

/** Splits a parsed session.json value into its parts. */
function decodeMeta(value: unknown): Result<DecodedMeta, StorageError> {
  const m = MetaSchema.safeParse(value);
  if (!m.success) return err({ kind: "bad-session-json", message: issues(m.error) });
  const d = m.data;
  if (d.version !== SESSION_VERSION) return err({ kind: "unsupported-version", version: d.version });
  return decodeConfig(d.config ?? {}).andThen((config) =>
    Result.combine(d.clips.map(decodeClip)).map((clips): DecodedMeta => ({
      meta: {
        version: d.version,
        config,
        clips,
        formats: { features: d.features ?? null },
      },
      nextObj: d.next_obj ?? null,
    })),
  );
}

/** Parses session.json text into its parts. Hosts and `open` share this parser. */
export const decodeMetaText = (text: string): Result<DecodedMeta, StorageError> =>
  parseJson(text)
    .mapErr((message): StorageError => ({ kind: "bad-session-json", message }))
    .andThen(decodeMeta);

/** Fields in this order, without the undefined ones. */
const fields = (entries: ReadonlyArray<readonly [string, unknown]>): object =>
  Object.fromEntries(entries.filter(([, v]) => v !== undefined));

/** Keys that differ from the defaults, in DEFAULT_CONFIG order. */
const encodeConfig = (config: Partial<Config>): object =>
  fields(CONFIG_KEYS.map((k) => [k, config[k] === DEFAULT_CONFIG[k] ? undefined : config[k]] as const));

const encodeClip = (c: Clip): object => {
  const reserved = [...c.reserved].sort(([a], [b]) => a - b);
  return fields([
    ["path", c.path],
    ["key", c.key],
    ["times", c.times],
    ["fps", c.timing.kind === "rate" ? c.timing.fps : undefined],
    ["stills", c.timing.kind === "stills" ? true : undefined],
    ["shape", c.shape],
    ["captured", c.captured],
    ["keyframe_thresh", c.keyframeThresh ?? undefined],
    ["removed", c.removed?.at],
    ["next_n", reserved.length ? Object.fromEntries(reserved.map(([f, n]) => [String(f), n])) : undefined],
  ]);
};

/** session.json text for the session part and the object counter. */
export const metaText = (meta: SessionMeta, nextObj: number): string =>
  jsonText(
    fields([
      ["version", meta.version],
      ["config", encodeConfig(meta.config)],
      ["clips", meta.clips.map(encodeClip)],
      ["next_obj", nextObj],
      ["features", meta.formats.features ?? undefined],
    ]),
  );
