/**
 * Which session a command works on: `-C <dir>`, else the nearest folder at or above the working directory that holds
 * .eyespy/session.json (like git and .git). With `-i <clips>` it is a headless session in the cache dir, keyed by the
 * clips' content keys. locate computes those keys the way the server does, so a moved folder of frames keeps its cache.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { SESSION_FILE, SESSION_MARKER, emptySessionJson, parseMetaText } from "eyespy-core/storage/pure";
import { describeFramesError, frameFiles, framesKey } from "eyespy-core/video/pure";
import type { ClipKey, FrameDigest } from "eyespy-core/video/pure";
import type { LocatePorts } from "./ports.ts";

export type { LocateFs } from "./ports.ts";

const HASH_BATCH = 8;

export type LocateError =
  | { readonly kind: "no-such-file"; readonly path: string }
  /** A clip that isn't a folder of frames; `message` says why. */
  | { readonly kind: "not-a-clip"; readonly message: string }
  /** `-C <dir>` names a folder that isn't a session. `dir` is as given. */
  | { readonly kind: "no-session-at"; readonly dir: string }
  | { readonly kind: "not-in-session" }
  | { readonly kind: "already-session"; readonly root: string }
  /** A session.json that doesn't parse (headless clip check). */
  | { readonly kind: "bad-session"; readonly root: string; readonly message: string }
  | { readonly kind: "host"; readonly op: string; readonly message: string };

/** How the command line names its session: `-C <dir>`, `-i <clips>` (headless, wins), or neither (walk up). */
type Where = { readonly session?: string | undefined; readonly videos: readonly string[] };

/** The session a command works on: its root (absolute) and the videos (as given) it has no live clip of. */
export type Located = { readonly root: string; readonly missing: readonly string[] };

export interface Locator {
  /** The session for these flags. It creates a headless session on first use. `missing` is empty unless headless. */
  find(where: Where): ResultAsync<Located, LocateError>;
  /**
   * Makes `dir` a session, creating the folder if missing. `dir` defaults to the working directory. Refuses an existing
   * session.
   */
  init(dir: string | undefined): ResultAsync<string, LocateError>;
  /** A video the user named, as an absolute path; `no-such-file` if it isn't there. */
  video(file: string): ResultAsync<string, LocateError>;
}

export type CreateLocator = (ports: LocatePorts) => Locator;

const hostError =
  (op: string) =>
  (e: unknown): LocateError => ({ kind: "host", op, message: e instanceof Error ? e.message : String(e) });

export const createLocator: CreateLocator = ({ fs, env }) => {
  const abs = (p: string) => path.resolve(env.cwd, p);
  const marker = (root: string) => path.join(root, SESSION_MARKER);
  const metaFile = (root: string) => path.join(marker(root), SESSION_FILE);
  const exists = (p: string) => ResultAsync.fromPromise(fs.exists(p), hostError("exists"));
  const isSession = (root: string) => exists(metaFile(root));

  const create = (root: string): ResultAsync<string, LocateError> =>
    ResultAsync.fromPromise(fs.mkdir(marker(root)), hostError("mkdir"))
      .andThen(() => ResultAsync.fromPromise(fs.writeText(metaFile(root), emptySessionJson()), hostError("write")))
      .map(() => root);

  const video = (file: string): ResultAsync<string, LocateError> => {
    const p = abs(file);
    return exists(p).andThen((yes) => (yes ? okAsync(p) : errAsync({ kind: "no-such-file", path: file } as const)));
  };

  /** Each frame's sha1, HASH_BATCH files at a time (a folder can hold thousands). */
  const digestsOf = (dir: string, frames: readonly string[]): Promise<readonly FrameDigest[]> =>
    Array.from({ length: Math.ceil(frames.length / HASH_BATCH) }, (_, i) =>
      frames.slice(i * HASH_BATCH, (i + 1) * HASH_BATCH),
    ).reduce<Promise<readonly FrameDigest[]>>(
      async (acc, batch) => [
        ...(await acc),
        ...(await Promise.all(batch.map(async (name) => ({ name, sha1: await fs.sha1(path.join(dir, name)) })))),
      ],
      Promise.resolve([]),
    );

  const clipKey = (dir: string): ResultAsync<ClipKey, LocateError> => {
    const p = abs(dir);
    return ResultAsync.fromPromise(fs.isDir(p), hostError("stat"))
      .andThen((yes) =>
        yes
          ? ResultAsync.fromPromise(fs.list(p), hostError("list"))
          : errAsync<readonly string[], LocateError>({
              kind: "not-a-clip",
              message: `${p} is a file; a clip is a folder of frames (extract them first, see the README)`,
            }),
      )
      .andThen((names) =>
        frameFiles(names).match(
          (frames) => okAsync(frames),
          (e) => errAsync<readonly string[], LocateError>({ kind: "not-a-clip", message: describeFramesError(p, e) }),
        ),
      )
      .andThen((frames) => ResultAsync.fromPromise(digestsOf(p, frames), hostError("read")))
      .andThen((digests) => ResultAsync.fromSafePromise(framesKey(digests)));
  };

  /** Checks that every file exists before it hashes any, and reports the first missing one. */
  const keysOf = (videos: readonly string[]): ResultAsync<readonly ClipKey[], LocateError> =>
    videos
      .reduce<ResultAsync<null, LocateError>>((acc, v) => acc.andThen(() => video(v).map(() => null)), okAsync(null))
      .andThen(() => ResultAsync.combine(videos.map(clipKey)));

  /** The videos whose key (same order) isn't a live clip of the session at `root`. */
  const missingOf = (
    root: string,
    videos: readonly string[],
    keys: readonly ClipKey[],
  ): ResultAsync<readonly string[], LocateError> =>
    ResultAsync.fromPromise(fs.readText(metaFile(root)), hostError("read"))
      .andThen((text) =>
        parseMetaText(text).mapErr((e): LocateError => ({
          kind: "bad-session",
          root,
          message: "message" in e ? e.message : e.kind,
        })),
      )
      .map((meta) => {
        const have = new Set<string>(meta.clips.filter((c) => !c.removed).map((c) => c.key));
        return videos.filter((_, i) => !have.has(keys[i] ?? ""));
      });

  const headless = (videos: readonly string[]): ResultAsync<Located, LocateError> =>
    keysOf(videos).andThen((keys) => {
      const key = createHash("sha1").update(keys.toSorted().join(",")).digest("hex").slice(0, 12);
      const root = path.join(env.cacheDir, key);
      return isSession(root)
        .andThen((yes) => (yes ? okAsync(root) : create(root)))
        .andThen(() => missingOf(root, videos, keys))
        .map((missing) => ({ root, missing }));
    });

  const managed = (root: string): Located => ({ root, missing: [] });

  const walkUp = (dir: string): ResultAsync<string, LocateError> =>
    isSession(dir).andThen((yes) => {
      if (yes) return okAsync(dir);
      const up = path.dirname(dir);
      return up === dir ? errAsync({ kind: "not-in-session" } as const) : walkUp(up);
    });

  return {
    find: ({ session, videos }) => {
      if (videos.length) return headless(videos);
      if (session !== undefined) {
        const root = abs(session);
        return isSession(root).andThen((yes) =>
          yes ? okAsync(managed(root)) : errAsync({ kind: "no-session-at", dir: session } as const),
        );
      }
      return walkUp(abs(".")).map(managed);
    },
    init: (dir) => {
      const root = abs(dir ?? ".");
      return isSession(root).andThen((yes) =>
        yes ? errAsync({ kind: "already-session", root } as const) : create(root),
      );
    },
    video,
  };
};
