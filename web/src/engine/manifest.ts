/**
 * What the browser engine downloads at runtime. This file is data only. Tests and dev builds pass their own copy, for
 * example with every entry pointing at a localhost server.
 *
 * `models` uses the core's model file names (MODEL_FILES) as keys. Each entry has its own URL,
 * absolute or relative to the page, so one manifest can mix origins. DownloadCache checks and caches each file by
 * sha256.
 */
export type ModelEntry = { url: string; sha256: string; bytes: number };
export type ModelManifest = Record<string, ModelEntry>;

/**
 * Runtime assets that are code, not weights, and too big to inline into the single HTML file. The engine checks and
 * caches them by hash like the models.
 */
export type RuntimeAssets = {
  /** onnxruntime-web's WebGPU wasm. It must match the installed onnxruntime-web version. */
  ortWasm: ModelEntry;
};

// CardAnvilModels/sam3-ONNX pinned to a commit
const HF = "https://huggingface.co/CardAnvilModels/sam3-ONNX/resolve/7eee2d79268e794e433b6e49467c5340525ac228";

/** Production layout. The detectors and DINOv2 come from the site, the SAM 3 encoders and tokenizer from HF. */
export const PRODUCTION_MODELS: ModelManifest = {
  "vision_fp16.onnx": {
    url: `${HF}/onnx/vision_fp16.onnx`,
    sha256: "02e1573a208a702dfbed03349fcbcf0b9bc228ee1ce24a6809b871f0cb1564fa",
    bytes: 914738433,
  },
  "text_fp16.onnx": {
    url: `${HF}/onnx/text_fp16.onnx`,
    sha256: "a2dfb1755d2c821451657b998d095b00727e8b400e706e95165c59039aca15b3",
    bytes: 709242464,
  },
  "tokenizer.json": {
    url: `${HF}/tokenizer.json`,
    sha256: "6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35",
    bytes: 3642073,
  },
  // The detectors have their Sign ops rewritten and their metadata stripped.
  "detector_fp32_nosign.onnx": {
    url: "models/detector_fp32_nosign.onnx",
    sha256: "58668cc33539a82f297c194e12b90c2bfccfb649f77a048c15dea84d1d6d3564",
    bytes: 102036400,
  },
  "detector_fp16_nosign.onnx": {
    url: "models/detector_fp16_nosign.onnx",
    sha256: "d7d8796f9dabffadd3af2a157413dd8a39a5a12e9e04190410e693699baf7d91",
    bytes: 51125743,
  },
  // onnx-community/dinov2-small fp32 with a Gather of the CLS token appended to its output
  "dinov2-small/model_cls.onnx": {
    url: "models/dinov2-small/model_cls.onnx",
    sha256: "1dba083dc0347706ff10aec6b9ed7d7580743ccbda728c2e137252a1bbaccd26",
    bytes: 88532979,
  },
};

const NPM = "https://cdn.jsdelivr.net/npm";
/** node_modules-relative paths, so a local mirror (runtimeMirror) serves the same files. */
const ORT_PATH = "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm";

export const PRODUCTION_RUNTIME: RuntimeAssets = {
  ortWasm: {
    url: `${NPM}/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm`,
    sha256: "39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da",
    bytes: 26781914,
  },
};

/** The runtime assets with ort's wasm from a node_modules mirror (dev server, tests), with the same hashes. */
export function runtimeMirror(base: string): RuntimeAssets {
  const b = base.endsWith("/") ? base : base + "/";
  return { ...PRODUCTION_RUNTIME, ortWasm: { ...PRODUCTION_RUNTIME.ortWasm, url: b + ORT_PATH } };
}

/** Every model under one base URL with the models/onnx layout (dev server, tests). */
export function localManifest(base: string, from: ModelManifest = PRODUCTION_MODELS): ModelManifest {
  const b = base.endsWith("/") ? base : base + "/";
  return Object.fromEntries(Object.entries(from).map(([name, e]) => [name, { ...e, url: b + name }]));
}

/** Resolves relative URLs against the page, so the worker gets absolute ones (an inlined worker has a blob: origin). */
export function absolutize<T extends Record<string, unknown>>(m: T, base: string): T {
  const abs = (u: string) => new URL(u, base).href;
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [
      k,
      typeof v === "string" ? abs(v) : { ...(v as ModelEntry), url: abs((v as ModelEntry).url) },
    ]),
  ) as T;
}
