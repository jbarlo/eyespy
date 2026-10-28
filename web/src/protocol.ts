/** Messages between the page and the engine worker, and the schemas each side checks what it receives with. */
import { z } from "zod";
import type { ModelManifest, RuntimeAssets } from "./engine/manifest.ts";

/** Where the session lives: a named folder under the origin's private file system, or a user-picked folder. */
export type SessionLocation = { opfs: string } | { dir: FileSystemDirectoryHandle };

export type InitOptions = {
  models: ModelManifest; // absolute URLs
  runtime: RuntimeAssets; // absolute URLs
  session: SessionLocation;
  detector?: "fp32" | "fp16";
  featureCacheMB?: number;
  /** Save vision features in the session folder. When off, features stay in RAM and get re-encoded on reopen. */
  persistFeatures?: boolean;
  /** Disk budget for stored features in MB, or null for unlimited. */
  featureDiskMB?: number | null;
  /** Host versions for the manifest's provenance (code revision etc.). */
  host?: Record<string, string | null>;
  /** The page's answer to the SAM License check (the worker has no localStorage); guardSamModels acts on it. */
  samLicenseAgreed?: boolean;
};

/** A video this browser can't decode, sent just before its add fails. The page explains how to convert it. */
export type UnsupportedVideo = {
  file: string; // the picked file's name
  codec: string; // such as "hvc1.2.4.L123.B0", or "unknown" when the container isn't readable
  codecName: string; // such as "HEVC/H.265"
  reason: string;
};

export type EngineEvent =
  | { kind: "download"; name: string; loaded: number; total: number; source: "network" | "cache"; done: boolean }
  | { kind: "log"; text: string }
  | { kind: "progress"; file: string; stage: string; fraction: number }
  | ({ kind: "unsupported" } & UnsupportedVideo)
  | { kind: "ready"; root: string; device: string };

export type ToWorker =
  | { t: "init"; id: number; opts: InitOptions }
  | { t: "rpc"; id: number; path: string; kind: "query" | "mutation"; input?: unknown }
  | { t: "file"; id: number; key: string }
  | { t: "register"; id: number; file: File }
  | { t: "prepare"; id: number; names?: string[] };

type RpcError = { message: string; code: string; stack?: string };

export type FromWorker =
  { t: "reply"; id: number; result?: unknown; error?: RpcError } | { t: "event"; ev: EngineEvent };

// Receivers check the envelope (`t`, `id`) and the scalar fields, and require payloads only to be objects. The router's
// zod schemas check rpc inputs, and our own code in the same bundle builds the init options and events on the other
// side.

const id = z.number().int();
const object = <T>() => z.custom<T>((v) => typeof v === "object" && v !== null);

export const TO_WORKER: z.ZodType<ToWorker> = z.discriminatedUnion("t", [
  z.object({ t: z.literal("init"), id, opts: object<InitOptions>() }),
  z.object({
    t: z.literal("rpc"),
    id,
    path: z.string(),
    kind: z.enum(["query", "mutation"]),
    input: z.unknown().optional(),
  }),
  z.object({ t: z.literal("file"), id, key: z.string() }),
  z.object({ t: z.literal("register"), id, file: z.instanceof(File) }),
  z.object({ t: z.literal("prepare"), id, names: z.array(z.string()).optional() }),
]);

export const FROM_WORKER: z.ZodType<FromWorker> = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("reply"),
    id,
    result: z.unknown().optional(),
    error: z.object({ message: z.string(), code: z.string(), stack: z.string().optional() }).optional(),
  }),
  z.object({ t: z.literal("event"), ev: object<EngineEvent>() }),
]);

/** store.locate() in the browser: a reference the page resolves to an object URL via the worker. */
export const STORE_REF = "eyespy-store:";

/**
 * The prefix of the worker's error for a SAM 3 file it may not fetch or load (no agreement). The page recognises the
 * error by it.
 */
export const SAM_LICENSE_REFUSED = "SAM License not accepted";
