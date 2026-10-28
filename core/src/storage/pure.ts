/** The storage values hosts may import. */
export {
  ALREADY_RUNNING,
  SERVER_LOCK,
  SERVER_LOG,
  SERVER_SOCKET,
  SESSION_FILE,
  SESSION_MARKER,
  SOCKET_TOO_LONG,
  emptySessionJson,
  isFeatureDir,
  parseMetaText,
  socketPathFits,
} from "./marker.ts";
/** The ways opening a session folder can fail. */
export type { StorageError } from "./types.ts";
