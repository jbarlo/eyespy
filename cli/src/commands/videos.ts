/** The session and its videos: init, add, clips (list / rm), status, stop. */
import { reply } from "../format/index.ts";
import { fail, show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";

export const specs = {
  init: {
    description: "Make a directory a session (one point in time; add clips of it)",
    args: { dir: { type: "string", description: "Session directory (default: current; created if missing)" } },
    options: {
      add: {
        type: "string[]",
        short: "a",
        argName: "frames",
        description: "Clip (a folder of frames) to add right away; repeatable; --fps applies to each",
      },
    },
  },
  add: {
    description:
      "Add a clip of the same moment: a folder of frames (JPEG/PNG, in name order) at --fps <n>, or of photos " +
      "without --fps (each one a keyframe). Picks keyframes, encodes them in the background",
    args: { video: { type: "string", required: true, description: "Folder of frames" } },
  },
  clips: {
    description: "List the session's clips, or remove one: eyespy clips rm <path|name|key>",
    args: {
      action: { type: "string", description: "rm: remove a clip (its detections leave every object; not undoable)" },
      clip: { type: "string", description: "Clip to remove: path, file name or key" },
    },
    options: { all: { type: "boolean", short: "a", description: "Also list removed clips" } },
  },
  stop: { description: "Stop this session's server (it also exits on its own when idle)" },
  status: { description: "Clips, encoding progress, objects, todo" },
} as const;

type S = typeof specs;

/** @internal */
export const init: Command<S["init"]> = (args, opts, env) => env.session.init(args.dir, opts.add ?? []);

/** @internal */
export const add: Command<S["add"]> = (args, _o, env) => env.session.addClip(args.video);

/** @internal */
export const clips: Command<S["clips"]> = (args, opts, env) => {
  if (args.action === undefined)
    return env.session.call("clips.list", { all: opts.all }).map(show(env, reply.clipsTable));
  if (args.action !== "rm") return fail(`unknown clips action ${args.action}; use: eyespy clips rm <path|name|key>`, 2);
  if (!args.clip) return fail("which clip? eyespy clips rm <path|name|key>", 2);
  return env.session.call("clips.remove", { clip: args.clip }).map(show(env, reply.clipRemoved));
};

/** @internal */
export const stop: Command<S["stop"]> = (_a, _o, env) => env.session.stop();

const status: Command<S["status"]> = (_a, _o, env) => env.session.call("status", {}).map(show(env, reply.status));

export const actions = <R>(wrap: Wrap<R>) => ({
  init: wrap(init),
  add: wrap(add),
  clips: wrap(clips),
  stop: wrap(stop),
  status: wrap(status),
});
