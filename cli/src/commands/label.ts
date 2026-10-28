/** Commands that decide what the detections are: objects (eyespy obj ...) and rejects. */
import { CROP_SHEET_MAX } from "eyespy-core/render/pure";
import { reply } from "../format/index.ts";
import { fail, show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";
import { frames, ids, k, objArg, threshold } from "./options.ts";

const objSpecs = {
  new: {
    description: "Create an object from detections (moves them from any other object)",
    args: { label: { type: "string", required: true }, ids: ids("Detections to attach") },
  },
  add: {
    description: "Attach more sightings to an object",
    args: { obj: objArg, ids: ids("Detections to attach") },
  },
  remove: {
    description: "Detach detections from an object (use object x to un-reject)",
    args: { obj: objArg, ids: ids("Detections to detach") },
  },
  merge: {
    description: "Fold one object into another",
    args: { into: objArg, from: { type: "string", required: true, description: "Object to absorb" } },
  },
  label: {
    description: "Rename an object",
    args: { obj: objArg, label: { type: "string", required: true } },
  },
  delete: { description: "Delete an object (its detections go back to todo)", args: { obj: objArg } },
  show: {
    description: "Close-up sheet of an object's sightings, one per alias group (x = rejects)",
    args: { obj: objArg },
    options: {
      frames,
      offset: { type: "number", default: 0, description: `First sighting to show (pages of ${CROP_SHEET_MAX})` },
    },
  },
  suggest: {
    description: "Unassigned detections that look like this object",
    args: { obj: objArg },
    options: { k: k(8, "Matches to return"), threshold },
  },
  match: {
    description: "Which object is this? Existing objects ranked by similarity to the detections",
    args: { ids: ids("Detections (several: their mean appearance)") },
    options: { k: k(5, "Objects to return") },
  },
} as const;

export const specs = {
  obj: { description: "Group detections into real items (LLM-controlled dedupe)", subcommands: objSpecs },
  reject: {
    description: "Mark detections as not-an-item (they leave todo)",
    // jimkit-cli registers a variadic positional as required (<ids...>), so `reject -p <prompt>` still needs one id.
    // The check below also covers a call with none.
    args: { ids: { type: "string", variadic: true, description: "Detections to reject" } },
    options: {
      prompt: { type: "string", short: "p", description: "Reject every unassigned detection of this prompt" },
    },
  },
} as const;

type O = typeof objSpecs;

/** @internal */
export const objNew: Command<O["new"]> = (args, _o, env) =>
  env.session.call("obj.new", { label: args.label, ids: args.ids }).map(show(env, reply.obj));
const objAdd: Command<O["add"]> = (args, _o, env) =>
  env.session.call("obj.add", { obj: args.obj, ids: args.ids }).map(show(env, reply.obj));
const objRemove: Command<O["remove"]> = (args, _o, env) =>
  env.session.call("obj.remove", { obj: args.obj, ids: args.ids }).map(show(env, reply.obj));
/** @internal */
export const objMerge: Command<O["merge"]> = (args, _o, env) =>
  env.session.call("obj.merge", { into: args.into, from: args.from }).map(show(env, reply.obj));
const objLabel: Command<O["label"]> = (args, _o, env) =>
  env.session.call("obj.label", { obj: args.obj, label: args.label }).map(show(env, reply.obj));
/** Text even with --json. @internal */
export const objDelete: Command<O["delete"]> = (args, _o, env) =>
  env.session.call("obj.delete", { obj: args.obj }).map(reply.objDeleted);
const objShow: Command<O["show"]> = (args, opts, env) =>
  env.session
    .call("obj.show", { obj: args.obj, frames: opts.frames, offset: opts.offset })
    .map(show(env, (r) => reply.objShow(r, opts.offset)));
const objSuggest: Command<O["suggest"]> = (args, opts, env) =>
  env.session
    .call("obj.suggest", { obj: args.obj, k: opts.k, threshold: opts.threshold })
    .map(show(env, reply.objSuggest));
const objMatch: Command<O["match"]> = (args, opts, env) =>
  env.session.call("obj.match", { ids: args.ids, k: opts.k }).map(show(env, reply.objMatch));

/** @internal */
export const reject: Command<(typeof specs)["reject"]> = (args, opts, env) => {
  const given = args.ids ?? [];
  if (!given.length && !opts.prompt) return fail("give detection ids or --prompt", 2);
  return env.session.call("reject", { ids: given, prompt: opts.prompt }).map(show(env, reply.rejected));
};

export const actions = <R>(wrap: Wrap<R>) => ({
  "obj.new": wrap(objNew),
  "obj.add": wrap(objAdd),
  "obj.remove": wrap(objRemove),
  "obj.merge": wrap(objMerge),
  "obj.label": wrap(objLabel),
  "obj.delete": wrap(objDelete),
  "obj.show": wrap(objShow),
  "obj.suggest": wrap(objSuggest),
  "obj.match": wrap(objMatch),
  reject: wrap(reject),
});
