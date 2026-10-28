/** What every command file shares: the command signature, its environment, failures, small Result helpers. */
import type { ArgConfig, InferArgs, InferOpts, OptionConfig } from "jimkit-cli";
import { errAsync } from "neverthrow";
import type { ResultAsync } from "neverthrow";
import { json } from "../format/index.ts";
import type { CliError, SessionLink } from "./session.ts";

export type { CliError } from "./session.ts";

/** Writes the files a command produces (`eyespy export`). */
export interface Files {
  write(path: string, text: string): ResultAsync<void, CliError>;
}

export type Env = {
  readonly json: boolean;
  readonly session: SessionLink;
  readonly files: Files;
};

export type Outcome = ResultAsync<string, CliError>;

/** A command's arguments and options as jimkit-cli parses them from its spec. */
type ArgsOf<C> = C extends { readonly args: infer A extends Record<string, ArgConfig> }
  ? InferArgs<A>
  : Record<string, never>;
type OptsOf<C> = C extends { readonly options: infer O extends Record<string, OptionConfig> }
  ? InferOpts<O>
  : Record<string, never>;
export type Command<C> = (args: ArgsOf<C>, opts: OptsOf<C>, env: Env) => Outcome;

export const fail = (message: string, exitCode?: number): Outcome =>
  errAsync(exitCode === undefined ? { message } : { message, exitCode });

/** Each command file exports `actions(wrap)`, which maps its action keys (`obj.new`, ...) to its wrapped handlers. */
export type Wrap<R> = <A, O>(cmd: (args: A, opts: O, env: Env) => Outcome) => (args: A, opts: O, globals: unknown) => R;

/** `--json` prints the reply, otherwise `text(reply)`. */
export const show =
  <R extends object>(env: Env, text: (r: R) => string) =>
  (r: R): string =>
    env.json ? json(r) : text(r);
