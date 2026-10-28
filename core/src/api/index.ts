/**
 * The api module is the wire format: the tRPC router, the op table and the error wording. It hides tRPC and zod
 * from the session.
 */
export type { OpPath } from "./pure.ts";
export { /** @internal */ OPS, isOpPath, opKind } from "./pure.ts";
export type { Inputs, Outputs } from "./types.ts";
export { /** @internal */ ERRORS, describeComposeError, /** @internal */ describeError } from "./errors.ts";
export { appRouter, createCaller } from "./router.ts";
export type { AppRouter } from "./router.ts";
