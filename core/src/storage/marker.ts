/**
 * The storage values hosts need before a session exists, or without one. The dependency rules let hosts import
 * values from this file.
 */
import { isClipKey } from "../video/pure.ts";
import type { ParseMetaText } from "./types.ts";
import { featDir } from "./internal/keys.ts";
import { decodeMetaText } from "./internal/meta.ts";

export const SESSION_MARKER = ".eyespy";

/** session.json, relative to the marker folder. A folder is a session if `<root>/.eyespy/session.json` exists. */
export const SESSION_FILE = "session.json";

/** The running server's pid lock, in the marker folder. The server takes it and the CLI watches it. */
export const SERVER_LOCK = "server.lock";
export const SERVER_SOCKET = "sock";
/** What the CLI and the server say when a session's socket path doesn't fit a unix socket address. */
export const SOCKET_TOO_LONG = "the session path is too long for a unix socket";
/**
 * Whether a socket path, in UTF-8 bytes, fits a unix socket address on `platform` (Node's process.platform). sun_path
 * holds 108 bytes on Linux, which needs no closing NUL there, and 104 bytes with the NUL on macOS and the BSDs.
 */
export const socketPathFits = (sock: string, platform: string): boolean =>
  new TextEncoder().encode(sock).length <= (platform === "linux" ? 108 : 103);
/** The log of a server the CLI started, in the marker folder. Stdout and stderr are appended to it. */
export const SERVER_LOG = "server.log";
/** Exit code of a server that found the session's lock held by a live server (EX_TEMPFAIL). */
export const ALREADY_RUNNING = 75;

/** A new session's session.json, with JSON indent 1. */
export const emptySessionJson = (): string => JSON.stringify({ version: 1, config: {}, clips: [] }, null, 1);

/** Parses session.json text into its session part and stored next_obj (null if absent), as `open` does. */
export const parseMetaText: ParseMetaText = (text) =>
  decodeMetaText(text).map((d) => ({ ...d.meta, nextObj: d.nextObj }));

/**
 * Whether a folder, given as its path below a session root (`[".eyespy", "clips", <key>, "feat"]`), is a clip's
 * feature folder.
 */
export const isFeatureDir = (parts: readonly string[]): boolean => {
  const [marker, , key] = parts;
  return (
    marker === SESSION_MARKER &&
    key !== undefined &&
    isClipKey(key) &&
    parts.length === 4 &&
    parts.slice(1).join("/") === featDir(key)
  );
};
