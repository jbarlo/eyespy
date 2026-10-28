/** The eyespy CLI entry point. It plugs the Node adapters into the commands. */
import { builtins, defineCLI, err as cliErr, ok as cliOk } from "jimkit-cli";
import type { Result as CliResult } from "jimkit-cli";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ResultAsync } from "neverthrow";
import { z } from "zod";
import * as configCmd from "./commands/config.ts";
import * as exportCmd from "./commands/export.ts";
import * as findCmd from "./commands/find.ts";
import { globalOptions, parseGlobals } from "./commands/flags.ts";
import * as historyCmd from "./commands/history.ts";
import type { Env, Files, Outcome } from "./commands/kit.ts";
import * as labelCmd from "./commands/label.ts";
import * as lookCmd from "./commands/look.ts";
import { createSessionLink } from "./commands/session.ts";
import type { SessionDeps } from "./commands/session.ts";
import * as videosCmd from "./commands/videos.ts";
import { createLocator } from "./locate/index.ts";
import { nodeLocateEnv, nodeLocateFs } from "./locate/node.ts";
import { createRpc } from "./rpc/index.ts";
import { connectSocket } from "./rpc/node.ts";
import { createServerProcess } from "./serverproc/index.ts";
import { nodeServerFs, nodeSpawner, sleep } from "./serverproc/node.ts";

// The server runs from the code checkout; sessions live wherever the user runs `eyespy init`.
const CODE = path.resolve(import.meta.dirname, "../..");
// The flake's eyespy wrapper sets EYESPY_SERVER to its eyespy-server launcher.
const SERVER = process.env.EYESPY_SERVER ?? "eyespy-server";

const rpc = createRpc({ connect: connectSocket, platform: process.platform });
const notice = (line: string) => void process.stderr.write(`${line}\n`);
const deps: SessionDeps = {
  locator: createLocator({ fs: nodeLocateFs, env: nodeLocateEnv(process.env, process.cwd()) }),
  server: createServerProcess(
    {
      spawner: nodeSpawner,
      fs: nodeServerFs,
      sleep,
      notice,
      answers: (socket) =>
        rpc.call(socket, "status", {}).match(
          () => true,
          (e) => e.kind === "op",
        ),
    },
    { command: SERVER, cwd: CODE },
  ),
  rpc,
  notice,
};
const files: Files = {
  write: (file, text) =>
    ResultAsync.fromPromise(writeFile(file, text), (e) => ({ message: e instanceof Error ? e.message : String(e) })),
};

const action =
  <A, O>(cmd: (args: A, opts: O, env: Env) => Outcome) =>
  async (args: A, opts: O, globals: unknown): Promise<CliResult<string>> => {
    const outcome = await parseGlobals(globals)
      .map(({ json, ...flags }): Env => ({ json, session: createSessionLink(deps, flags), files }))
      .asyncAndThen((env) => cmd(args, opts, env));
    return outcome.match(
      (text) => cliOk(text),
      (e) => cliErr(e.message, e.exitCode),
    );
  };

const completionsBuiltin = builtins.completions();
const v = videosCmd.specs;
const f = findCmd.specs;
const l = lookCmd.specs;
const h = historyCmd.specs;

const cli = defineCLI({
  name: "eyespy",
  version: "0.1.0",
  description: "eyespy: find and catalogue the objects in a video, locally on your machine",
  completers: {
    static: { ...completionsBuiltin.completers?.static },
  },
  globalOptions,
  // `--help` order
  commands: {
    init: v.init,
    add: v.add,
    clips: v.clips,
    stop: v.stop,
    status: v.status,
    config: configCmd.specs.config,
    export: exportCmd.specs.export,
    sheet: f.sheet,
    find: f.find,
    show: l.show,
    crop: l.crop,
    similar: l.similar,
    dets: l.dets,
    obj: labelCmd.specs.obj,
    search: f.search,
    undo: h.undo,
    redo: h.redo,
    history: h.history,
    reject: labelCmd.specs.reject,
    todo: l.todo,
    gaps: l.gaps,
    semantic: f.semantic,
    manifest: exportCmd.specs.manifest,
    completions: completionsBuiltin.command,
  },
});

const SHELL = z.object({ shell: z.enum(["bash", "zsh", "fish"]) });

void cli.run(process.argv, {
  ...videosCmd.actions(action),
  ...configCmd.actions(action),
  ...exportCmd.actions(action),
  ...findCmd.actions(action),
  ...lookCmd.actions(action),
  ...labelCmd.actions(action),
  ...historyCmd.actions(action),
  completions: (args) => {
    // the builtin's CommandConfig is untyped here, so its positional isn't in `args`' type
    const parsed = SHELL.safeParse(args);
    return parsed.success ? cliOk(cli.completion(parsed.data.shell)) : cliErr("shell must be bash, zsh or fish", 2);
  },
});
