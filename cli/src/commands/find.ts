/** Commands that find things: the contact sheet, text prompts, region search, heatmaps. */
import { reply } from "../format/index.ts";
import { fail, show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";
import { boxArg, crops, frameArg, frames, k, parseBox, threshold } from "./options.ts";

export const specs = {
  sheet: { description: "Contact sheet of keyframes with their indices", options: { frames } },
  find: {
    description: "Segment every instance of a text concept",
    args: { prompt: { type: "string", required: true, description: "Short noun phrase, e.g. 'ketchup bottle'" } },
    options: { frames, crops, threshold },
  },
  search: {
    description:
      "Search a region of one keyframe: crop + upscale, then prompt and/or appearance similarity (not a SAM box prompt)",
    args: { frame: frameArg, box: boxArg },
    options: {
      prompt: { type: "string", short: "p", description: "Find this inside the region (hits become detections)" },
      k: k(8, "Similar detections to return"),
      threshold,
    },
  },
  semantic: {
    description: "SAM 3's per-pixel heatmap for a concept, with presence score per frame",
    args: { prompt: { type: "string", required: true } },
    options: {
      frames,
      uncovered: {
        type: "boolean",
        short: "u",
        description: "Zero out assigned/rejected regions: show only unexplained activation",
      },
    },
  },
} as const;

type S = typeof specs;

const BAD_BOX = "box must be x0,y0,x1,y1";

const sheet: Command<S["sheet"]> = (_a, opts, env) =>
  env.session.call("sheet", { frames: opts.frames }).map(show(env, reply.sheet));

/** @internal */
export const find: Command<S["find"]> = (args, opts, env) =>
  env.session
    .call("find", { prompt: args.prompt, frames: opts.frames, crops: opts.crops, threshold: opts.threshold })
    .map(show(env, (r) => reply.find(r, args.prompt)));

/** @internal */
export const search: Command<S["search"]> = (args, opts, env) => {
  const b = parseBox(args.box);
  if (!b) return fail(BAD_BOX, 2);
  return env.session
    .call("search", { frame: args.frame, box: b, prompt: opts.prompt, k: opts.k, threshold: opts.threshold })
    .map(show(env, reply.search));
};

const semantic: Command<S["semantic"]> = (args, opts, env) =>
  env.session
    .call("semantic", { prompt: args.prompt, frames: opts.frames, uncovered: opts.uncovered })
    .map(show(env, reply.semantic));

export const actions = <R>(wrap: Wrap<R>) => ({
  sheet: wrap(sheet),
  find: wrap(find),
  search: wrap(search),
  semantic: wrap(semantic),
});
