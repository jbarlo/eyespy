/**
 * The global flags and how they parse. Each session setting gets a per-call override flag from CONFIG_META
 * (`--presence 0.9`), except the settings in OWN_FLAG, which have a flag of their own. jimkit-cli hands globals over
 * untyped (numbers as strings, a string[] as its last value), so zod parses them.
 */
import type { GlobalOptionConfig } from "jimkit-cli";
import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { CONFIG_KEYS, CONFIG_META } from "eyespy-core/session/pure";
import type { ConfigKey } from "eyespy-core/session/pure";
import { z } from "zod";
import type { CliError, SessionFlags } from "./session.ts";

export type Globals = SessionFlags & { readonly json: boolean };

/** Settings with a flag of their own (`-t`, `--idle-minutes`). */
const OWN_FLAG: ReadonlySet<ConfigKey> = new Set(["threshold", "idle_minutes"]);
/** The highest frame rate `--fps` takes. */
const MAX_FPS = 1000;
const camel = (key: string) => key.replace(/_(.)/g, (_m, c: string) => c.toUpperCase());
/** Each CLI flag (camelCase; jimkit-cli prints it kebab-case) and its setting key, in CONFIG_KEYS order. @internal */
export const CONFIG_FLAGS: readonly (readonly [string, ConfigKey])[] = CONFIG_KEYS.filter((k) => !OWN_FLAG.has(k)).map(
  (k) => [camel(k), k] as const,
);
const configOptions: Readonly<Record<string, GlobalOptionConfig>> = Object.fromEntries(
  CONFIG_FLAGS.map(([flag, key]) => [
    flag,
    { type: "number", description: `Override for this call: ${CONFIG_META[key].doc}` },
  ]),
);

/** The global options as jimkit-cli specs, in `--help` order. */
export const globalOptions = {
  json: { type: "boolean", default: false, description: "Raw JSON output" },
  session: {
    type: "string",
    short: "C",
    argName: "dir",
    description: "Use the session at <dir> instead of searching up from here",
  },
  video: {
    type: "string[]",
    short: "i",
    argName: "frames",
    description:
      "Headless: work on these clips (frame folders, comma-separated) without a session dir; cached under ~/.cache/eyespy",
  },
  fps: {
    type: "number",
    argName: "n",
    description: "Frame rate of the frame folders this call adds; omit for a folder of photos",
  },
  ...configOptions,
  idleMinutes: { type: "number", description: "Idle minutes before a server started by this command exits" },
} as const;

const numberFlag = (flag: string) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (Number.isNaN(n)) ctx.addIssue({ code: "custom", message: `--${flag} needs a number` });
      return n;
    });
const GLOBALS = z.object({
  json: z.boolean().optional(),
  session: z.string().optional(),
  video: z.union([z.string(), z.array(z.string())]).optional(),
  idleMinutes: numberFlag("idleMinutes"),
  fps: numberFlag("fps").refine((n) => n === undefined || (Number.isFinite(n) && n > 0 && n <= MAX_FPS), {
    message: `--fps needs a frame rate above 0 (up to ${MAX_FPS})`,
  }),
  ...Object.fromEntries(CONFIG_FLAGS.map(([flag]) => [flag, numberFlag(flag)])),
});

/** Parses the raw global flags as jimkit-cli hands them over, or returns the first flag that doesn't parse. */
export const parseGlobals = (raw: unknown): Result<Globals, CliError> => {
  const parsed = GLOBALS.safeParse(raw);
  if (!parsed.success) return err({ message: parsed.error.issues[0]?.message ?? parsed.error.message });
  const g: Readonly<Record<string, unknown>> = parsed.data;
  const cfg: Partial<Record<ConfigKey, number>> = Object.fromEntries(
    CONFIG_FLAGS.flatMap(([flag, key]) => {
      const v = g[flag];
      return typeof v === "number" ? [[key, v] as const] : [];
    }),
  );
  const videos = [parsed.data.video ?? []]
    .flat()
    .flatMap((v) => v.split(","))
    .filter(Boolean);
  return ok({
    json: parsed.data.json ?? false,
    session: parsed.data.session,
    videos,
    cfg,
    idleMinutes: parsed.data.idleMinutes,
    fps: parsed.data.fps,
  });
};
