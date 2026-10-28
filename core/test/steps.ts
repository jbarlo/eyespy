/**
 * Records one router op per snapshot key: reply or error, ops.jsonl lines, store file changes and text drawn, so a
 * snapshot diff points at the op that changed.
 */
import { TRPCError } from "@trpc/server";
import type { Opened } from "./compose.ts";
import { changes } from "./fakes/index.ts";
import { normalise } from "./snapshot.ts";

/** Fields that measure time rather than behaviour. */
const VOLATILE = new Set(["seconds"]);

export function scrub(v: unknown): unknown {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object")
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([k]) => !VOLATILE.has(k))
          .map(([k, y]) => [k, walk(y)]),
      );
    return x;
  };
  return walk(normalise(v));
}

export type ErrorRecord = { code: string; message: string };

/** An error as the agent sees it, as tRPC code and message. For a zod error it keeps only the failing paths. */
export function errorRecord(e: unknown): ErrorRecord {
  if (e instanceof TRPCError) {
    const cause: unknown = e.cause;
    if (cause && typeof cause === "object" && "issues" in cause && Array.isArray(cause.issues)) {
      const paths = (cause.issues as { path?: unknown[] }[]).map((i) => (i.path ?? []).join("."));
      return { code: e.code, message: `(input validation: ${paths.join(", ")})` };
    }
    return { code: e.code, message: e.message };
  }
  return { code: "(not a TRPCError)", message: e instanceof Error ? e.message : String(e) };
}

export type StepRecord = {
  input: unknown;
  output?: unknown;
  error?: ErrorRecord;
  ops: string[];
  files: Record<string, string>;
  texts: string[];
};

export function recorder(o: Opened, match: (key: string, v: unknown) => void) {
  let n = 0;
  const opsText = () => o.host.store.files.get("ops.jsonl");
  const lines = () => {
    const b = opsText();
    return b ? new TextDecoder().decode(b).split("\n").filter(Boolean) : [];
  };
  async function run<I, O>(name: string, input: I, fn: (i: I) => Promise<O>, expectError: boolean) {
    o.host.clock.advance(1234); // not whole seconds, because ts is a float in real logs
    const before = o.host.store.fingerprint();
    const opsBefore = lines().length;
    o.host.codec.takeTexts();
    const rec: StepRecord = { input: normalise(input), ops: [], files: {}, texts: [] };
    let out: O | undefined;
    try {
      out = await fn(input);
      rec.output = scrub(out);
    } catch (e) {
      rec.error = errorRecord(e);
    }
    await o.settle();
    rec.ops = lines().slice(opsBefore);
    rec.files = changes(before, o.host.store.fingerprint());
    rec.texts = o.host.codec.takeTexts();
    match(`${String(++n).padStart(3, "0")} ${name}`, rec);
    if (expectError && !rec.error) throw new Error(`step ${n} ${name}: expected an error, got a reply`);
    if (!expectError && rec.error) throw new Error(`step ${n} ${name}: ${rec.error.code} ${rec.error.message}`);
    return out as O;
  }
  return {
    ok: <I, O>(name: string, input: I, fn: (i: I) => Promise<O>) => run(name, input, fn, false),
    err: async <I, O>(name: string, input: I, fn: (i: I) => Promise<O>) => {
      await run(name, input, fn, true);
    },
  };
}
