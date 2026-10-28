/** Commands that show the results: overlays, crops, look-alikes, the detection list, the todo queue, gaps. */
import { okAsync } from "neverthrow";
import { CROP_SHEET_MAX, GROUP_PAGE } from "eyespy-core/render/pure";
import { reply } from "../format/index.ts";
import { fail, show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";
import { crops, frames, k, threshold } from "./options.ts";

export const specs = {
  show: {
    description: "Render detections on keyframes (assigned ones labelled by object)",
    options: {
      frames,
      crops,
      threshold,
      objects: { type: "boolean", short: "o", description: "Only assigned items, colored and labelled by object" },
      rejects: { type: "boolean", short: "r", description: "Only rejected detections" },
    },
  },
  crop: {
    description: "Full-res crop of one detection (for reading labels)",
    args: { id: { type: "string", required: true, description: "Detection id, e.g. 14.3" } },
  },
  similar: {
    description: "Detections on other keyframes that look like this one (dedupe candidates)",
    args: { id: { type: "string", required: true, description: "Detection id" } },
    options: { k: k(8, "Matches to return"), threshold },
  },
  dets: {
    description: "List detections",
    options: {
      frames,
      crops,
      threshold,
      prompt: { type: "string", short: "p", description: "Only this prompt's detections" },
    },
  },
  todo: {
    description: "Work queue: detections not yet assigned or rejected (one per same-frame alias group)",
    options: {
      crops,
      threshold,
      prompt: { type: "string", short: "p", description: "Only this prompt's detections" },
      limit: { type: "number", short: "n", default: CROP_SHEET_MAX, description: "Max to list" },
      frames,
      groups: {
        type: "boolean",
        short: "g",
        description: "Propose items: cluster lookalikes near in time, one sheet row each",
      },
      offset: { type: "number", default: 0, description: `First group to show (pages of ${GROUP_PAGE})` },
    },
  },
  gaps: {
    description: "Keyframes with assigned/rejected regions darkened, to spot what was missed",
    options: { frames },
  },
} as const;

type S = typeof specs;

const showDets: Command<S["show"]> = (_a, opts, env) =>
  env.session
    .call("show", {
      frames: opts.frames,
      crops: opts.crops,
      threshold: opts.threshold,
      objects: opts.objects,
      rejects: opts.rejects,
    })
    .map(show(env, reply.hits));

const crop: Command<S["crop"]> = (args, _o, env) =>
  env.session.call("crop", { id: args.id }).map(show(env, reply.crop));

const similar: Command<S["similar"]> = (args, opts, env) =>
  env.session.call("similar", { id: args.id, k: opts.k, threshold: opts.threshold }).map(show(env, reply.similar));

const dets: Command<S["dets"]> = (_a, opts, env) =>
  env.session
    .call("dets", { frames: opts.frames, crops: opts.crops, threshold: opts.threshold, prompt: opts.prompt })
    .map(show(env, reply.hits));

/** @internal */
export const todo: Command<S["todo"]> = (_a, opts, env) => {
  const body = {
    crops: opts.crops,
    threshold: opts.threshold,
    prompt: opts.prompt,
    limit: opts.limit,
    frames: opts.frames,
  };
  return opts.groups
    ? env.session
        .call("todo", { ...body, groups: true, offset: opts.offset })
        .andThen((r) =>
          "groups" in r
            ? okAsync(show(env, (g: typeof r) => reply.todoGroups(g, opts.offset))(r))
            : fail("server did not return groups"),
        )
    : env.session
        .call("todo", body)
        .andThen((r) => ("hits" in r ? okAsync(show(env, reply.todo)(r)) : fail("server did not return hits")));
};

/** @internal */
export const gaps: Command<S["gaps"]> = (_a, opts, env) =>
  env.session.call("gaps", { frames: opts.frames }).map(show(env, reply.hits));

export const actions = <R>(wrap: Wrap<R>) => ({
  show: wrap(showDets),
  crop: wrap(crop),
  similar: wrap(similar),
  dets: wrap(dets),
  todo: wrap(todo),
  gaps: wrap(gaps),
});
