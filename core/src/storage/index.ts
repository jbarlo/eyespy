/**
 * The storage module owns the session folder (`.eyespy/`), its file names and byte formats. Consumers get typed
 * facades, and only the marker names leave it. ops.jsonl is append-only. session.json and the other record files
 * are rewritten from the domain state.
 */
export { createSessionFolder } from "./internal/folder.ts";
export type { SessionFolder, SessionRecords, StorageError } from "./types.ts";
