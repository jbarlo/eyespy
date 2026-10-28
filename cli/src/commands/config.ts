/** Shows the session settings, or sets one. */
import { reply } from "../format/index.ts";
import { show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";

export const specs = {
  config: {
    description: "Show settings, or set one: eyespy config <key> <value>",
    args: { key: { type: "string" }, value: { type: "string" } },
  },
} as const;

/** @internal */
export const config: Command<(typeof specs)["config"]> = (args, _o, env) =>
  env.session.call("config", { key: args.key, value: args.value }).map(show(env, (r) => reply.config(r, args.key)));

export const actions = <R>(wrap: Wrap<R>) => ({ config: wrap(config) });
