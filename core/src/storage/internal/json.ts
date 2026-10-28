/**
 * The session folder's two JSON text formats: indent-1 JSON for the record files, and one-line JSON for ops.jsonl.
 * ops.jsonl lines keep non-ASCII raw and write whole-second numbers without ".0".
 */
import type { z } from "zod";

export type JsonObject = Readonly<Record<string, unknown>>;

export const jsonText = (v: unknown): string => JSON.stringify(v, null, 1);

/**
 * JSON with `", "` and `": "` separators, for ops.jsonl lines. Object keys keep their insertion order. Keys whose
 * value is `undefined` are left out, as JSON.stringify does.
 */
export function lineJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(lineJson).join(", ")}]`;
  if (typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${lineJson(x)}`)
      .join(", ")}}`;
  return JSON.stringify(v);
}

/** A zod error as one line of `path: message` per issue, joined by `; `, for bad-record and bad-session-json. */
export const issues = (e: z.ZodError): string =>
  e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
