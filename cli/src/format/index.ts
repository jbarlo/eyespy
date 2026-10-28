/**
 * Turns every reply into the text a command prints, and the CLI's errors into words. Agents parse this text, so change
 * wording and columns only on purpose.
 */
export {
  /** @internal */ hitLine,
  /** @internal */ hitsBlock,
  /** @internal */ objLine,
  /** @internal */ ranges,
} from "./lines.ts";
export type { Hit, Obj } from "./lines.ts";
export * as reply from "./replies.ts";
export { locateError, rpcError, serverError } from "./errors.ts";

/** `--json` prints the reply as the server sent it, after `"ok": true`, with a one-space indent. */
export const json = (r: object): string => JSON.stringify({ ok: true, ...r }, null, 1);
