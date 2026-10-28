/** What the labelling produced: the itemized manifest, and its export to a JSON file. */
import { reply } from "../format/index.ts";
import { show } from "./kit.ts";
import type { Command, Wrap } from "./kit.ts";
import { crops } from "./options.ts";

export const specs = {
  export: {
    description: "Write the manifest (with model/config provenance) to a JSON file",
    args: { file: { type: "string", required: true } },
  },
  manifest: { description: "Itemized inventory from objects", options: { crops } },
} as const;

type S = typeof specs;

/** @internal */
export const exportManifest: Command<S["export"]> = (args, _o, env) =>
  env.session.call("manifest", {}).andThen((r) => {
    const { image: _image, ...manifest } = r;
    return env.files.write(args.file, JSON.stringify(manifest, null, 1) + "\n").map(() => reply.exported(r, args.file));
  });

/** @internal */
export const manifest: Command<S["manifest"]> = (_a, opts, env) =>
  env.session.call("manifest", { crops: opts.crops }).map(show(env, reply.manifest));

export const actions = <R>(wrap: Wrap<R>) => ({ export: wrap(exportManifest), manifest: wrap(manifest) });
