/**
 * ModelRuntime without ONNX; models are picked by file name (MODEL_FILES).
 *
 *   vision     zero features except an 8-value header in features_288: has-stamp flag, the scene stamp and a pixel
 *              hash. Small integers, so they survive the fp16 feature cache exactly.
 *   text       the first 32 values of text_features are the token ids (TOKENIZER_JSON maps each byte to one
 *              token), so the detector can decode the prompt again.
 *   detector   decodes the header and prompt and asks the `detector` callback for a DetectorScript. Unscripted
 *              queries get logit -20 and an empty mask, below any score floor.
 *   dino       pooler_output from the `appearance` callback on each 224² crop (default: a colour signature, so
 *              crops of one scene object match across frames).
 */
import { createHash } from "node:crypto";
import { APPEARANCE_DIM, FEATURE_PLANES, MASK_SIZE, MODEL_FILES } from "../../src/perception/pure.ts";
import { SAM_SIZE } from "../../src/perception/internal/sam/pixels.kernel.ts";
import type { RGB } from "../../src/pixels/index.ts";
import type { Model, ModelRuntime, Tensor } from "../../src/ports/index.ts";
import { decodeStamp, stampPoint, type FrameStamp } from "./stamp.ts";

/** x0, y0, x1, y1 as fractions of the encoded image (a frame, or a region-search crop). */
export type Rect = readonly [number, number, number, number];
/** `slot` is the query index. The default is the next free one. */
export type Query = { rect: Rect; logit: number; slot?: number };
export type DetectorScript = {
  /** Presence logit. The presence score is its sigmoid. */
  presence: number;
  queries: readonly Query[];
  /** Semantic map: logit +5 inside these rects and -5 elsewhere, raw 288² logits, or none. */
  semantic?: readonly Rect[] | Float32Array | null;
};
/** What the detector knows about a call: the prompt (as tokenized: lowercase, whitespace collapsed) and image. */
export type DetectContext = {
  prompt: string;
  /** The scene stamp of the encoded image; null for images without one (crops). */
  frame: FrameStamp | null;
  /** Hash of the encoded image's pixels (tells crops apart). */
  image: string;
};

export type FakeRuntimeOptions = {
  detector?: (q: DetectContext) => DetectorScript;
  appearance?: (crop: RGB) => Float32Array;
};

export const QUERIES = 200;
export const VERY_NEGATIVE = -20;
const MASK_PIXELS = MASK_SIZE * MASK_SIZE;

// Synthetic tokenizer with one token per byte (GPT-2 byte alphabet), "</w>" variants and no merges.

function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++)
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  const out = new Array<string>(256).fill("");
  bs.forEach((b, i) => (out[b] = String.fromCodePoint(cs[i] ?? 0)));
  return out;
}
const BYTE_CHARS = bytesToUnicode();
const BOS = 0,
  EOS = 1;
const VOCAB: Record<string, number> = { "<|startoftext|>": BOS, "<|endoftext|>": EOS };
BYTE_CHARS.forEach((c, b) => {
  VOCAB[c] = 2 + b;
  VOCAB[`${c}</w>`] = 258 + b;
});
/** A tokenizer.json ClipTokenizer accepts. */
export const TOKENIZER_JSON = JSON.stringify({ model: { vocab: VOCAB, merges: [] } });

/** Turns token ids, as the text encoder receives them, back into the normalised prompt. */
export function decodePrompt(ids: ArrayLike<number>): string {
  const bytes: number[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k] ?? EOS;
    if (id === BOS) continue;
    if (id === EOS) break;
    const b = id >= 258 ? id - 258 : id - 2;
    bytes.push(b);
    if (id >= 258) bytes.push(0x20);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes)).trim();
}

/** FNV-1a over every 101st value. */
function hashValues(v: Float32Array): number {
  const u = new Uint32Array(v.buffer, v.byteOffset, v.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i += 101) {
    h ^= u[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const tensorOf = (r: Record<string, Tensor>, name: string): Tensor => {
  const t = r[name];
  if (!t) throw new Error(`fake runtime: input ${name} missing`);
  return t;
};
const floats = (t: Tensor): Float32Array => {
  if (!(t.data instanceof Float32Array)) throw new Error(`fake runtime: expected float32, got ${t.type}`);
  return t.data;
};
const f32 = (data: Float32Array, dims: number[]): Tensor => ({ type: "float32", data, dims });

/** Fill rect (fractions) of a 288² plane with `inside`, the rest with `outside`. */
export function rectPlane(out: Float32Array, rect: Rect, inside: number, outside: number) {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(Math.min(1, Math.max(0, v)) * MASK_SIZE));
  out.fill(outside);
  for (let y = y0 ?? 0; y < (y1 ?? 0); y++) out.fill(inside, y * MASK_SIZE + (x0 ?? 0), y * MASK_SIZE + (x1 ?? 0));
}

/** Detector outputs from a script, in the ONNX export's tensor layout. */
export function detectorOutputs(s: DetectorScript): Record<string, Tensor> {
  const logits = new Float32Array(QUERIES).fill(VERY_NEGATIVE);
  const masks = new Float32Array(QUERIES * MASK_PIXELS);
  let next = 0;
  for (const q of s.queries) {
    const slot = q.slot ?? next;
    if (slot < 0 || slot >= QUERIES) throw new Error(`fake detector: query slot ${slot} out of range`);
    next = Math.max(next, slot + 1);
    logits[slot] = q.logit;
    rectPlane(masks.subarray(slot * MASK_PIXELS, (slot + 1) * MASK_PIXELS), q.rect, 10, -10);
  }
  const out: Record<string, Tensor> = {
    pred_logits: f32(logits, [1, QUERIES]),
    pred_masks: f32(masks, [1, QUERIES, MASK_SIZE, MASK_SIZE]),
    presence_logits: f32(Float32Array.of(s.presence), [1, 1]),
  };
  if (s.semantic instanceof Float32Array) out.semantic_seg = f32(s.semantic, [1, 1, MASK_SIZE, MASK_SIZE]);
  else if (s.semantic) {
    const sem = new Float32Array(MASK_PIXELS).fill(-5);
    const plane = new Float32Array(MASK_PIXELS);
    for (const r of s.semantic) {
      rectPlane(plane, r, 1, 0);
      for (let i = 0; i < MASK_PIXELS; i++) if (plane[i]) sem[i] = 5;
    }
    out.semantic_seg = f32(sem, [1, 1, MASK_SIZE, MASK_SIZE]);
  }
  return out;
}

/**
 * Default appearance. It is a colour signature of the crop's non-grey pixels, made of three 128-bin Gaussian bumps at
 * the mean R, G and B. Grey pixels are skipped because they are the fill around the region, not the object. Crops of
 * one colour get one vector.
 */
export function colorSignature(crop: RGB): Float32Array {
  const sum = [0, 0, 0];
  let n = 0;
  const d = crop.data;
  for (let p = 0; p < crop.w * crop.h; p++) {
    const r = d[p * 3] ?? 0,
      g = d[p * 3 + 1] ?? 0,
      b = d[p * 3 + 2] ?? 0;
    if (Math.abs(r - 128) <= 3 && Math.abs(g - 128) <= 3 && Math.abs(b - 128) <= 3) continue;
    sum[0]! += r;
    sum[1]! += g;
    sum[2]! += b;
    n++;
  }
  const v = new Float32Array(APPEARANCE_DIM);
  const per = APPEARANCE_DIM / 3;
  for (let c = 0; c < 3; c++) {
    const centre = n ? (sum[c]! / n) * (per / 256) : per / 2;
    for (let k = 0; k < per; k++) v[c * per + k] = Math.exp(-((k - centre) ** 2) / 32);
  }
  return v;
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/** Undo the DINOv2 normalisation of item `i` of a [n, 3, 224, 224] batch. The batch holds rounded values. */
function dinoCrop(px: Float32Array, i: number): RGB {
  const P = 224 * 224;
  const data = new Uint8Array(P * 3);
  for (let c = 0; c < 3; c++)
    for (let p = 0; p < P; p++) {
      const v = (px[i * 3 * P + c * P + p] ?? 0) * IMAGENET_STD[c]! * 255 + IMAGENET_MEAN[c]! * 255;
      data[p * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  return { w: 224, h: 224, data };
}

/** The scene stamp in SAM-preprocessed pixels (CHW, (x/255 - 0.5)/0.5), read from the red channel. */
function stampOf(px: Float32Array): FrameStamp | null {
  const vals = [0, 1, 2, 3].map((k) => {
    const [x, y] = stampPoint(k, SAM_SIZE, SAM_SIZE);
    return Math.round((px[y * SAM_SIZE + x] ?? 0) * 127.5 + 127.5);
  });
  return decodeStamp(vals);
}

export class FakeModelRuntime implements ModelRuntime {
  loads: string[] = [];
  calls: Record<string, number> = {};
  detections: DetectContext[] = [];
  private detector: (q: DetectContext) => DetectorScript;
  private appearance: (crop: RGB) => Float32Array;

  constructor(opts: FakeRuntimeOptions = {}) {
    this.detector = opts.detector ?? (() => ({ presence: -4, queries: [] }));
    this.appearance = opts.appearance ?? colorSignature;
  }

  async load(name: string): Promise<Model> {
    const run = this.models()[name];
    if (!run) throw new Error(`fake runtime: no model ${name}`);
    this.loads.push(name);
    return {
      run: async (feeds) => {
        this.calls[name] = (this.calls[name] ?? 0) + 1;
        return run(feeds);
      },
    };
  }

  async readText(name: string): Promise<string> {
    if (name !== MODEL_FILES.tokenizer) throw new Error(`fake runtime: no text file ${name}`);
    return TOKENIZER_JSON;
  }

  describe() {
    return { runtime: "fake", version: "0.0.0", device: "cpu" };
  }

  async sha256(name: string): Promise<string> {
    return createHash("sha256").update(`fake model ${name}`).digest("hex");
  }

  private models(): Record<string, (feeds: Record<string, Tensor>) => Record<string, Tensor>> {
    const detector = (feeds: Record<string, Tensor>) => this.detect(feeds);
    return {
      [MODEL_FILES.vision]: (feeds) => this.vision(feeds),
      [MODEL_FILES.text]: (feeds) => this.text(feeds),
      [MODEL_FILES.detector.fp32]: detector,
      [MODEL_FILES.detector.fp16]: detector,
      [MODEL_FILES.appearance]: (feeds) => this.dino(feeds),
    };
  }

  private vision(feeds: Record<string, Tensor>): Record<string, Tensor> {
    const px = floats(tensorOf(feeds, "pixel_values"));
    const stamp = stampOf(px);
    const h = hashValues(px);
    const cs = stamp ? Math.round(stamp.t * 100) : 0;
    const header = [stamp ? 1 : 0, stamp?.clip ?? 0, (cs >> 8) & 0xff, cs & 0xff];
    for (let k = 0; k < 4; k++) header.push((h >>> (8 * k)) & 0xff);
    const names = ["features_288", "features_144", "features_72"];
    const out: Record<string, Tensor> = {};
    FEATURE_PLANES.map((p) => p.dims).forEach((dims, k) => {
      const data = new Float32Array(dims.reduce<number>((a, b) => a * b, 1));
      if (k === 0) data.set(header);
      out[names[k]!] = f32(data, [...dims]);
    });
    return out;
  }

  private text(feeds: Record<string, Tensor>): Record<string, Tensor> {
    const ids = tensorOf(feeds, "input_ids").data;
    const data = new Float32Array(32 * 256);
    for (let k = 0; k < 32; k++) data[k] = Number(ids[k] ?? EOS);
    return { text_features: f32(data, [1, 32, 256]) };
  }

  private detect(feeds: Record<string, Tensor>): Record<string, Tensor> {
    const f = floats(tensorOf(feeds, "features_288"));
    const v = (k: number) => Math.round(f[k] ?? 0);
    const frame = v(0) ? { clip: v(1), t: ((v(2) << 8) | v(3)) / 100 } : null;
    const image = [7, 6, 5, 4].map((k) => v(k).toString(16).padStart(2, "0")).join("");
    const prompt = decodePrompt(floats(tensorOf(feeds, "text_features")).subarray(0, 32));
    const q: DetectContext = { prompt, frame, image };
    this.detections.push(q);
    return detectorOutputs(this.detector(q));
  }

  private dino(feeds: Record<string, Tensor>): Record<string, Tensor> {
    const t = tensorOf(feeds, "pixel_values");
    const px = floats(t);
    const n = t.dims[0] ?? 0;
    const out = new Float32Array(n * APPEARANCE_DIM);
    for (let i = 0; i < n; i++) {
      const v = this.appearance(dinoCrop(px, i));
      if (v.length !== APPEARANCE_DIM) throw new Error(`fake appearance: ${v.length} values, want ${APPEARANCE_DIM}`);
      out.set(v, i * APPEARANCE_DIM);
    }
    return { pooler_output: f32(out, [n, APPEARANCE_DIM]) };
  }
}
