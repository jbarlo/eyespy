/** What storage requires: the host's byte store, and a clock for npz zip entry times and ops.jsonl `ts`. */
import type { Clock, SessionStore } from "../ports/index.ts";

export type StoragePorts = { readonly store: SessionStore; readonly clock: Clock };
