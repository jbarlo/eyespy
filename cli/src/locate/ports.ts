/** What locate needs from the host: a few file operations and where it runs. Promises reject on host failure. */
export interface LocateFs {
  exists(path: string): Promise<boolean>;
  /** mkdir -p */
  mkdir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  isDir(path: string): Promise<boolean>;
  /** Names of the entries of a directory that aren't directories themselves. */
  list(dir: string): Promise<readonly string[]>;
  /** Hex SHA-1 of a file's bytes. */
  sha1(path: string): Promise<string>;
}

export type LocateEnv = {
  /** The absolute working directory. Relative paths resolve against it, and the walk up starts there. */
  readonly cwd: string;
  /** Where headless sessions live: $XDG_CACHE_HOME/eyespy, else ~/.cache/eyespy. */
  readonly cacheDir: string;
};

export type LocatePorts = { readonly fs: LocateFs; readonly env: LocateEnv };
