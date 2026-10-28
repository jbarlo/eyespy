/** The object edit log: undo, redo, history. */
import { reply } from "../format/index.ts";
import { show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";

export const specs = {
  undo: { description: "Revert the latest object edit" },
  redo: { description: "Re-apply the latest undone object edit" },
  history: {
    description: "Object edit log (ops.jsonl), newest last",
    options: { n: { type: "number", short: "n", default: 20, description: "Entries to show" } },
  },
} as const;

type S = typeof specs;

const undo: Command<S["undo"]> = (_a, _o, env) => env.session.call("undo", {}).map(show(env, reply.undone));
const redo: Command<S["redo"]> = (_a, _o, env) => env.session.call("redo", {}).map(show(env, reply.redone));
/** @internal */
export const history: Command<S["history"]> = (_a, opts, env) =>
  env.session.call("data.history", {}).map(show(env, (r) => reply.history(r, opts.n)));

export const actions = <R>(wrap: Wrap<R>) => ({ undo: wrap(undo), redo: wrap(redo), history: wrap(history) });
