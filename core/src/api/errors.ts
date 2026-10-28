/**
 * Maps every SessionError kind to a tRPC code and the message agents see. The wording is public API, since agents
 * parse it and snapshots pin it.
 */
import { TRPCError } from "@trpc/server";
import type { ReplayFailure, SessionError } from "../session/index.ts";
import type { StorageError } from "../storage/pure.ts";
import type { ErrorCode, ErrorTable } from "./types.ts";

const bad = "BAD_REQUEST" as const;
const internal = "INTERNAL_SERVER_ERROR" as const;

/** Why an undo/redo can't be replayed. */
const replayText = (r: ReplayFailure): string => {
  switch (r.kind) {
    case "exists":
      return `object ${r.obj} already exists`;
    case "gone":
      return `object ${r.obj} no longer exists`;
    case "label-mismatch":
      return `object ${r.obj} is labelled ${JSON.stringify(r.actual)}, expected ${JSON.stringify(r.expected)}`;
    case "members-missing":
      return `object ${r.obj} no longer holds ${r.ids.join(", ")}`;
    case "members-present":
      return `object ${r.obj} already holds ${r.ids.join(", ")}`;
    case "not-an-object":
      return `${JSON.stringify(r.obj)} in its diff is not an object id (ops.jsonl was edited by hand?)`;
  }
};

export const ERRORS: ErrorTable = {
  "unknown-setting": { code: bad, message: (e) => `unknown setting ${e.key}; known: ${e.known.join(", ")}` },
  "unknown-settings": { code: bad, message: (e) => `unknown setting(s) ${e.keys.join(", ")}` },
  "bad-setting-value": { code: bad, message: (e) => `not a number: '${e.value}'` },
  "no-frames": { code: bad, message: () => "no frames" },
  "region-too-small": { code: bad, message: (e) => `region ${e.w}×${e.h} is too small (${e.min} px minimum)` },
  "missing-heatmap": { code: bad, message: (e) => `missing sem/${e.ref}` },
  "shutting-down": { code: internal, message: () => "server is shutting down" },
  "no-keyframe": { code: bad, message: (e) => `no keyframe ${e.frame}` },
  "missing-frame-file": { code: bad, message: (e) => `missing frame file of keyframe ${e.frame}` },
  "bad-frame-spec": { code: bad, message: (e) => `bad frame spec: ${e.part}` },
  "no-such-file": { code: bad, message: (e) => `no such file: ${e.path}` },
  "clip-already-present": { code: bad, message: (e) => `${e.path} is already in this session` },
  "no-clip": { code: bad, message: (e) => `no clip ${e.ref} in this session (eyespy clips lists them)` },
  "ambiguous-clip": {
    code: bad,
    message: (e) => `${e.ref} matches ${e.keys.length} clips; use the key (${e.keys.join(", ")})`,
  },
  "clip-already-removed": { code: bad, message: (e) => `${e.path} was already removed` },
  "clip-no-keyframes": { code: bad, message: (e) => `${e.path} has no keyframes` },
  "model-output-missing": {
    code: internal,
    message: (e) => `model ${e.model} has no usable output ${e.output} (not the ONNX export this code expects)`,
  },
  "bad-tokenizer": { code: internal, message: (e) => `bad tokenizer.json: ${e.message}` },
  "no-detection": { code: bad, message: (e) => `no detection ${e.id}` },
  "run-exists": { code: internal, message: (e) => `run ${e.run.prompt} on frame ${e.run.frame} is already recorded` },
  "no-object": { code: bad, message: (e) => `no object ${e.id}` },
  "object-no-members": { code: bad, message: (e) => `object ${e.id} has no members` },
  "merge-reject": { code: bad, message: () => "use reject / obj remove x for rejects" },
  "merge-self": { code: bad, message: () => "cannot merge an object into itself" },
  "delete-reject": { code: bad, message: () => "cannot delete the reject set" },
  "nothing-to-undo": { code: bad, message: () => "nothing to undo" },
  "nothing-to-redo": { code: bad, message: () => "nothing to redo" },
  "cannot-replay": { code: bad, message: (e) => `cannot ${e.op} #${e.seq} (${e.of}): ${replayText(e.reason)}` },
  // Host errors pass the adapter's message through. Video adapter failures are about the user's file.
  host: { code: (e) => (e.port === "video" ? bad : internal), message: (e) => e.message },
};

export const describeError = (e: SessionError): { readonly code: ErrorCode; readonly message: string } => {
  // Indexing by a union kind loses the kind-to-rule pairing. The table's type guarantees it, so the cast is safe.
  const rule = ERRORS[e.kind] as {
    readonly code: ErrorCode | ((x: SessionError) => ErrorCode);
    readonly message: (x: SessionError) => string;
  };
  return { code: typeof rule.code === "function" ? rule.code(e) : rule.code, message: rule.message(e) };
};

export const toTRPCError = (e: SessionError): TRPCError => {
  const { code, message } = describeError(e);
  return new TRPCError({ code, message, cause: e });
};

/** Why a session folder failed to open, in words. Every host uses this wording. */
export const describeComposeError = (e: StorageError | SessionError): string => {
  switch (e.kind) {
    case "no-session":
      return `no session.json in ${e.root}`;
    case "bad-session-json":
      return `session.json: ${e.message}`;
    case "unsupported-version":
      return `session.json version ${e.version} is not supported (eyespy reads version 1)`;
    case "bad-record":
      return `${e.file}: ${e.message}`;
    case "missing-detection-file":
      return `missing dets/${e.id}.npz`;
    default:
      return describeError(e).message;
  }
};
