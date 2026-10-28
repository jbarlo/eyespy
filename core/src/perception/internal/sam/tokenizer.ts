/**
 * Builds a ClipTokenizer from tokenizer.json, read from the model directory through the runtime. The file is
 * untrusted, so zod parses it. A file without the two special tokens gives a `bad-tokenizer` error.
 */
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import { z } from "zod";
import { parseJson } from "../../../railway/index.ts";
import type { PerceptionError } from "../../types.ts";
import { ClipTokenizer } from "./tokenizer.kernel.ts";

const TokenizerJson = z.object({
  model: z.object({
    vocab: z.record(z.string(), z.number()),
    merges: z.array(z.union([z.string(), z.tuple([z.string(), z.string()])])),
  }),
});

const bad = (message: string): PerceptionError => ({ kind: "bad-tokenizer", message });

export function parseTokenizer(text: string): Result<ClipTokenizer, PerceptionError> {
  return parseJson(text)
    .mapErr((m) => bad(`tokenizer.json is not JSON: ${m}`))
    .andThen((raw) => {
      const parsed = TokenizerJson.safeParse(raw);
      if (!parsed.success) return err(bad(`tokenizer.json: ${parsed.error.message}`));
      const { vocab, merges } = parsed.data.model;
      const v = new Map(Object.entries(vocab));
      const ranks = new Map(
        merges.map((m, i) => {
          const [a, b] = typeof m === "string" ? m.split(" ") : m;
          return [`${a} ${b}`, i] as const;
        }),
      );
      const bos = v.get("<|startoftext|>");
      const eos = v.get("<|endoftext|>");
      if (bos === undefined || eos === undefined)
        return err(bad("tokenizer.json has no <|startoftext|>/<|endoftext|>"));
      return ok(new ClipTokenizer({ vocab: v, ranks, bos, eos }));
    });
}
