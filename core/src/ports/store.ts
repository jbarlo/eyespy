/**
 * Session storage, keyed by paths relative to the session's `.eyespy/` directory ("dets/1.2.npz"). Only `storage/`
 * uses these keys. A missing file gives `null` or `false`, never a rejection.
 */
export type StoredFile = {
  /** The file name, without the folder. */
  readonly name: string;
  readonly size: number;
  /** Last modified, in ms since the epoch. A file written later never has an earlier mtime. */
  readonly mtime: number;
};

export interface SessionStore {
  readText(key: string): Promise<string | null>;
  /** Replaces the file atomically. */
  writeText(key: string, text: string): Promise<void>;
  appendText(key: string, text: string): Promise<void>;
  /**
   * The file's bytes, which belong to the caller. The host never reuses or changes them, so the caller may keep a
   * view over them. They may be a view into a larger buffer, so honour byteOffset and byteLength.
   */
  read(key: string): Promise<Uint8Array | null>;
  /** The store keeps no reference to `data`, so the caller may reuse it once the promise resolves. */
  write(key: string, data: Uint8Array): Promise<void>;
  /** Whether a file (not a folder) is stored at `key`. */
  exists(key: string): Promise<boolean>;
  /** Does nothing if the file is missing. */
  remove(key: string): Promise<void>;
  /** Deletes a directory and everything under it. Does nothing if it is missing. */
  removeDir(key: string): Promise<void>;
  /** A file's size in bytes, or null if it is missing or a folder. */
  size(key: string): Promise<number | null>;
  /** The files directly in folder `dir`, not its sub-folders, in any order. Empty if the folder is missing. */
  list(dir: string): Promise<readonly StoredFile[]>;
  /** How the client refers to a stored file (a filesystem path in Node, a URL in a browser). */
  locate(key: string): string;
  /** The session root as shown to users. */
  readonly root: string;
}
