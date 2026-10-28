/**
 * Parses (zod) the server's command line and environment into its options. A bad value is an Err carrying one line
 * for the user, which the caller prints with USAGE.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { Result, err, ok } from "neverthrow";
import { z } from "zod";

export type ServerArgs = {
  /** The session root (absolute). */
  readonly root: string;
  /** The absolute model directory. */
  readonly models: string;
  readonly detector: "fp32" | "fp16";
  readonly cpu: boolean;
  readonly idleMinutes: number | undefined;
  readonly featureCacheMB: number | undefined;
  /** Disk budget in MB for stored features; null means unlimited. */
  readonly featureDiskMB: number | null;
  readonly profile: boolean;
};

/** An unset or empty value is absent. */
const unset = (v: unknown) => (v === "" ? undefined : v);
const positive = z.preprocess(
  unset,
  z.coerce.number({ error: "expected a number" }).positive("must be > 0").finite().optional(),
);
const DETECTORS = ["fp32", "fp16"] as const;
const detector = z.preprocess(unset, z.enum(DETECTORS, { error: `must be ${DETECTORS.join(" or ")}` }).optional());
const text = z.preprocess(unset, z.string().optional());

const Flags = z.object({
  session: z.string({ error: "required" }).min(1, "required"),
  models: text,
  "idle-minutes": positive,
  detector,
  cpu: z.boolean(),
  "feature-disk-mb": positive,
});

/** Each flag's argument as USAGE shows it; null marks a boolean flag. */
const FLAG_ARG: Readonly<Record<keyof typeof Flags.shape, string | null>> = {
  session: "<dir>",
  models: "<dir>",
  "idle-minutes": "N",
  detector: DETECTORS.join("|"),
  cpu: null,
  "feature-disk-mb": "N",
};
/** The server's flags, in USAGE order. @internal */
export const flagNames = Object.keys(Flags.shape) as (keyof typeof Flags.shape)[];

export const USAGE = `usage: eyespy-server ${flagNames
  .map((k) => {
    const arg = FLAG_ARG[k];
    const shown = arg === null ? `--${k}` : `--${k} ${arg}`;
    return Flags.shape[k].safeParse(undefined).success || arg === null ? `[${shown}]` : shown;
  })
  .join(" ")}`;

const Env = z.object({
  EYESPY_MODELS: text,
  EYESPY_DETECTOR: detector,
  EYESPY_FEATURE_CACHE_MB: positive,
  EYESPY_FEATURE_DISK_MB: positive,
  EYESPY_PROFILE: text,
});

/** The environment variables the server reads. @internal */
export const envNames = Object.keys(Env.shape);

export const HELP = [
  "eyespy-server: find and catalogue the objects in a video, locally on your machine",
  "",
  USAGE,
  "",
  "The session server the eyespy CLI starts on demand (one per session, on <session>/.eyespy/sock); it exits after",
  "--idle-minutes without requests.",
  `Env: ${envNames.join(", ")}.`,
].join("\n");

const issue = (prefix: (key: string) => string, e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.length ? `${prefix(String(i.path[0]))}: ` : ""}${i.message}`).join("; ");

const splitArgs = Result.fromThrowable(
  (argv: readonly string[]) =>
    parseArgs({
      args: [...argv],
      options: Object.fromEntries(
        flagNames.map((k) => [k, FLAG_ARG[k] === null ? { type: "boolean", default: false } : { type: "string" }]),
      ),
    }).values,
  (e) => (e instanceof Error ? e.message : String(e)),
);

/** `argv` (without node and the script), the process env, and the code checkout (for the default model dir). */
export function parseServerArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  code: string,
): Result<ServerArgs, string> {
  return splitArgs(argv).andThen((values) => {
    const flags = Flags.safeParse(values);
    if (!flags.success) return err(issue((k) => `--${k}`, flags.error));
    const vars = Env.safeParse(env);
    if (!vars.success) return err(issue((k) => k, vars.error));
    const f = flags.data;
    const v = vars.data;
    return ok({
      root: path.resolve(f.session),
      models: path.resolve(f.models ?? v.EYESPY_MODELS ?? path.join(code, "models", "onnx")),
      detector: f.detector ?? v.EYESPY_DETECTOR ?? "fp32",
      cpu: f.cpu,
      idleMinutes: f["idle-minutes"],
      featureCacheMB: v.EYESPY_FEATURE_CACHE_MB,
      featureDiskMB: f["feature-disk-mb"] ?? v.EYESPY_FEATURE_DISK_MB ?? null,
      profile: v.EYESPY_PROFILE !== undefined,
    });
  });
}
