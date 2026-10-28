/**
 * CLIP BPE tokenizer over the SAM 3 text encoder's parsed HF `tokenizer.json`. It applies NFC, collapses
 * whitespace and lowercases, then splits with CLIP's regex. It maps bytes to the byte-level alphabet and runs BPE
 * with "</w>" word ends. Output is <|startoftext|> … <|endoftext|>, padded with <|endoftext|> to a fixed length.
 * It assumes the vocabulary has been checked.
 */

const SPLIT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
// ByteLevel's own GPT-2 regex, applied to each piece. Pieces have no spaces, so only the contraction rules matter.
const BYTELEVEL = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function bytesToUnicode(): readonly string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const out = new Array<string>(256);
  bs.forEach((b, i) => (out[b] = String.fromCodePoint(cs[i]!))); // bs and cs are built in lockstep
  return out;
}

/** input_ids and attention_mask, maxLength long. */
export type Encoded = { readonly ids: readonly bigint[]; readonly mask: readonly bigint[] };

export type Vocabulary = {
  readonly vocab: ReadonlyMap<string, number>;
  /** Merge rank by pair, keyed "a b". */
  readonly ranks: ReadonlyMap<string, number>;
  readonly bos: number;
  readonly eos: number;
};

export class ClipTokenizer {
  private readonly byteMap = bytesToUnicode();
  private readonly cache = new Map<string, number[]>();
  readonly pad: number;

  constructor(
    private readonly v: Vocabulary,
    readonly maxLength = 32,
  ) {
    this.pad = v.eos;
  }

  private bpe(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let parts = [...word];
    parts[parts.length - 1] += "</w>";
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.v.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      const a = parts[best];
      const b = parts[best + 1];
      if (a === undefined || b === undefined) break; // best < 0, so no pair is left to merge
      const next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (i < parts.length - 1 && p === a && parts[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(p);
      }
      parts = next;
    }
    const ids = parts.map((p) => this.v.vocab.get(p) ?? this.v.eos);
    this.cache.set(word, ids);
    return ids;
  }

  tokens(text: string): number[] {
    const norm = text.normalize("NFC").replace(/\s+/gu, " ").toLowerCase();
    const out: number[] = [];
    for (const piece of norm.match(SPLIT) ?? []) {
      if (piece === "<|startoftext|>") {
        out.push(this.v.bos);
        continue;
      }
      if (piece === "<|endoftext|>") {
        out.push(this.v.eos);
        continue;
      }
      for (const sub of piece.match(BYTELEVEL) ?? []) {
        const mapped = [...new TextEncoder().encode(sub)].map((b) => this.byteMap[b]).join("");
        out.push(...this.bpe(mapped));
      }
    }
    return out;
  }

  /** input_ids and attention_mask as the SAM 3 processor builds them, padded or truncated to maxLength. */
  encode(text: string): Encoded {
    const body = this.tokens(text).slice(0, this.maxLength - 2);
    const ids = [this.v.bos, ...body, this.v.eos];
    const mask = ids.map(() => 1);
    while (ids.length < this.maxLength) {
      ids.push(this.pad);
      mask.push(0);
    }
    return { ids: ids.map(BigInt), mask: mask.map(BigInt) };
  }
}
