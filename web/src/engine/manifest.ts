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

// jbarlo/eyespy-models on Hugging Face, pinned to a commit
const HF = "https://huggingface.co/jbarlo/eyespy-models/resolve/7d55bf5697d2d229e72aef402ddbf921c3a74110";

/** Production layout: every model file comes from the pinned Hugging Face repo. */
export const PRODUCTION_MODELS: ModelManifest = {
  "vision_fp16.onnx": {
    url: `${HF}/sam3/vision_fp16.onnx`,
    sha256: "02e1573a208a702dfbed03349fcbcf0b9bc228ee1ce24a6809b871f0cb1564fa",
    bytes: 914738433,
  },
  "text_fp16.onnx": {
    url: `${HF}/sam3/text_fp16.onnx`,
    sha256: "a2dfb1755d2c821451657b998d095b00727e8b400e706e95165c59039aca15b3",
    bytes: 709242464,
  },
  "tokenizer.json": {
    url: `${HF}/sam3/tokenizer.json`,
    sha256: "6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35",
    bytes: 3642073,
  },
  // The detectors have their Sign ops rewritten and their metadata stripped.
  "detector_fp32_nosign.onnx": {
    url: `${HF}/sam3/detector_fp32_nosign.onnx`,
    sha256: "58668cc33539a82f297c194e12b90c2bfccfb649f77a048c15dea84d1d6d3564",
    bytes: 102036400,
  },
  "detector_fp16_nosign.onnx": {
    url: `${HF}/sam3/detector_fp16_nosign.onnx`,
    sha256: "d7d8796f9dabffadd3af2a157413dd8a39a5a12e9e04190410e693699baf7d91",
    bytes: 51125743,
  },
  // onnx-community/dinov2-small fp32 with a Gather of the CLS token appended to its output
  "dinov2-small/model_cls.onnx": {
    url: `${HF}/dinov2-small/model_cls.onnx`,
    sha256: "1dba083dc0347706ff10aec6b9ed7d7580743ccbda728c2e137252a1bbaccd26",
    bytes: 88532979,
  },
};

/**
 * The tracker graphs and vision parts, which are not published anywhere yet, so they have no URL and PRODUCTION_MODELS
 * can't name them.
 * Only a dev page with its own model server gets them (`?models=<base>&tracker`, see `localTracker`). Hashes and sizes
 * are from tools/models/README.md.
 */
const UNPUBLISHED_TRACKER: Readonly<Record<string, Omit<ModelEntry, "url">>> = {
  "tracker/tables.onnx": {
    sha256: "4f886770508990a5c4aa7e81467653df4de10f0b55587342758ff8ae682bb141",
    bytes: 1396246,
  },
  "tracker/neck_fp16.onnx": {
    sha256: "59018b16af3fe3eb036df3375e529dcbcd6f409359375334403ef55980df4858",
    bytes: 13953127,
  },
  "tracker/mask_embed_fp16.onnx": {
    sha256: "495b8f202a54318f0c9961cbf9ea05c70cfbccc2c4db9d045e412a5dfb3bc8c5",
    bytes: 14229,
  },
  "tracker/decoder_fp16.onnx": {
    sha256: "02675d4d8b341995aa3da61d149ea9c2b2c5621e85c1778121cccf867f576cee",
    bytes: 14302660,
  },
  "tracker/memenc_fp16.onnx": {
    sha256: "c69a8153b6afde57107ab4c367ef523b35dc8f818dbb1bf5a795e6ec837fb317",
    bytes: 2785679,
  },
  "tracker/attn_l0_fp16.onnx": {
    sha256: "24cb37487ec083e5dcd392d25c4061f416655a0c26e6290172b65fbc1b030c7e",
    bytes: 8401188,
  },
  "tracker/attn_l1_fp16.onnx": {
    sha256: "91ba07c7bed55476687cf93545b137dc26815596bf39a010c21712ecad4f3647",
    bytes: 3092167,
  },
  "tracker/attn_l2_fp16.onnx": {
    sha256: "d63920c2fc0671945dc6d31390148e517dad3984a75ad0ed50219a3861467f81",
    bytes: 3092167,
  },
  "tracker/attn_l3_fp16.onnx": {
    sha256: "1b6a063ebceb1437ab0521f0933d092809ecc8cc5bad58b0b655a9ddbea3c4ce",
    bytes: 3093804,
  },
  "tracker/neck_fp32.onnx": {
    sha256: "56dfc08233641b0d30890521c3a292d3fb920da0ed8eb7478195eb391b47000e",
    bytes: 27902252,
  },
  "tracker/mask_embed_fp32.onnx": {
    sha256: "358cda9894d5de0926bb4aa2f7f5489d1bcc283c9d46a4d6bc96c6f58c7fd109",
    bytes: 23640,
  },
  "tracker/decoder_fp32.onnx": {
    sha256: "88714ac7f38f0be392511f00e39472e5c60d6704789f685e819c1cf8b3350f33",
    bytes: 23246330,
  },
  "tracker/memenc_fp32.onnx": {
    sha256: "0af37e4d558a3a1345a9d1efd196b73c04499334b4064166a5994284b46f075d",
    bytes: 5555678,
  },
  "tracker/attn_l0_fp32.onnx": {
    sha256: "89eee38ea34721e29c801b7ced593f83d87f6683e98a94571a78d6cc51f3b6a3",
    bytes: 11329432,
  },
  "tracker/attn_l1_fp32.onnx": {
    sha256: "bb2a49464217c09f655e3f55dedc3dfae34ef942031018f8b4049c192522ce4b",
    bytes: 6020447,
  },
  "tracker/attn_l2_fp32.onnx": {
    sha256: "5540e445159aa97ed1d8d745559e0b9e1dc742f3eb528283cff985d2dafa6a64",
    bytes: 6020447,
  },
  "tracker/attn_l3_fp32.onnx": {
    sha256: "13029d3c001bccd0e561d02a7ee62cffb0d5cf1622ff91107798a62102350f07",
    bytes: 6023093,
  },
  "vision/part_00.onnx": {
    sha256: "3058c80092f8ddd3d87c8e0128e44a8c7ace8235d687dfb4203920a966c81335",
    bytes: 30490359,
  },
  "vision/part_01.onnx": {
    sha256: "11377f99da212b18d722f6dd74d25a1c88df1450d98c460915b74407becbd943",
    bytes: 28071929,
  },
  "vision/part_02.onnx": {
    sha256: "1bf01110f7540f9d3e93f2b1850d6280189a25ab0683897e9bbe4c99f1847a65",
    bytes: 28072056,
  },
  "vision/part_03.onnx": {
    sha256: "dda131e021ac8c1dd84ea359ac158f64762332df042f5dff043e6900971b34bd",
    bytes: 28072098,
  },
  "vision/part_04.onnx": {
    sha256: "551975865aa0d87238d07a932d6be98b192cbf5cd2b25e5c27c92340fbb5eba8",
    bytes: 28072118,
  },
  "vision/part_05.onnx": {
    sha256: "4f38c6376063f09762a9b241f4e201d0a976dc608273a4df518efc59949f0648",
    bytes: 28072263,
  },
  "vision/part_06.onnx": {
    sha256: "879f18828bc1b072b2c68d078e6cbdd7f2787371a6f44d6fe3f5648ed63cfb8c",
    bytes: 28072291,
  },
  "vision/part_07.onnx": {
    sha256: "ccdbe1ab37b17cc7718172464c0d10ba3a1f9ae5f52ce528938cb23d5a6f12cb",
    bytes: 28046582,
  },
  "vision/part_08.onnx": {
    sha256: "1a8fcd95c2730a3f47e280287700d88b5c5c952635a758dcc4e699d895ff5da7",
    bytes: 28072398,
  },
  "vision/part_09.onnx": {
    sha256: "76fdbd0409229a8301de89aa2e58c83f0640a3ec77a4d069f9f53202bd8d9e25",
    bytes: 28072440,
  },
  "vision/part_10.onnx": {
    sha256: "cc61b96395c148e6a13a8465236ae84c4227a97d000dfd99d4032aa8ceeaf072",
    bytes: 28072873,
  },
  "vision/part_11.onnx": {
    sha256: "c9a5caf134a7496c1a284c05e50bc2fe1c80ed22cecc195480d6bd044a5996d1",
    bytes: 28072881,
  },
  "vision/part_12.onnx": {
    sha256: "108637fa93e2bcf530cb9650c4d70626a10a1ae7aa2610a6866de31fe3f5b5c8",
    bytes: 28072909,
  },
  "vision/part_13.onnx": {
    sha256: "6396545c53f2984d1c787312a4ac8b874ac1b28ca35cc120c10e393f64d70e54",
    bytes: 28072925,
  },
  "vision/part_14.onnx": {
    sha256: "daefa8272023c6ddb7946cacf3db905abc9a8b983248d0936c887f6e71b896e9",
    bytes: 28072925,
  },
  "vision/part_15.onnx": {
    sha256: "25d6f3f0009cd78efce102e08a0e65d0a57b92eb3b25fd72ef1f3d62b4e6f56b",
    bytes: 28047122,
  },
  "vision/part_16.onnx": {
    sha256: "3c41ab72ad3d99aaf4d2f04bfa225c9b4e56b7333f033da63045659c6d424c4b",
    bytes: 28072950,
  },
  "vision/part_17.onnx": {
    sha256: "da66c58e53e04cfda0549be121f22735b14635dc055fdeb69b9c43c620457344",
    bytes: 28072990,
  },
  "vision/part_18.onnx": {
    sha256: "715ebfafdc5916d049b3ca590ed9bdc9b7ec605580b478cfa7d7858253d34c2a",
    bytes: 28072990,
  },
  "vision/part_19.onnx": {
    sha256: "fa3e15b49f03a024a89438e54e358cb8444688f5b445df43b91c6ede0e47c05d",
    bytes: 28072996,
  },
  "vision/part_20.onnx": {
    sha256: "f71ff109301e4ab8864c93e9ba3b9a7e33dfd020d406fe4cbe63a5d08194a2c7",
    bytes: 28073028,
  },
  "vision/part_21.onnx": {
    sha256: "1f170139f7d10d3008d643d56d5bf2a7e6cee8a078c22db789268d9f7b6f6046",
    bytes: 28073028,
  },
  "vision/part_22.onnx": {
    sha256: "ce8581a80f278c7b9d611536aac1e7d0a188009ff876dc51f85d6c2b504624d6",
    bytes: 28073028,
  },
  "vision/part_23.onnx": {
    sha256: "3dc348377ee38eab9965b414d29164f6d53c3139c35ca338b976be122af8a532",
    bytes: 28047225,
  },
  "vision/part_24.onnx": {
    sha256: "5ba4853a55675b5ea1853240473cd5afd52da27453890738fc12da598dccb9c3",
    bytes: 28073034,
  },
  "vision/part_25.onnx": {
    sha256: "94a490e835004b289b9d56236bde3c9814b68a3f5ceeba55219768315ee5c375",
    bytes: 28073106,
  },
  "vision/part_26.onnx": {
    sha256: "b6a9980e845af804610ad37873c78bfc29e2f9587769ee297a36519755f49539",
    bytes: 28073106,
  },
  "vision/part_27.onnx": {
    sha256: "4f5e11f33721c166d8290cb53fa1a0bdcff81705326d819eb0fa3cd0e2aaaabb",
    bytes: 28073106,
  },
  "vision/part_28.onnx": {
    sha256: "b388b201ce29d46571536489cb292370cdc306bead7a65fb1b6a900cae6d88d7",
    bytes: 28073106,
  },
  "vision/part_29.onnx": {
    sha256: "dce25e33c81f3d9291779429d7f26af00d289b864a45aafaec7d5c146deec147",
    bytes: 28073106,
  },
  "vision/part_30.onnx": {
    sha256: "382e6847fd3d5fea57d6f392206a42dd903ff75c57c8fcc82f17f3f6fecc1ddb",
    bytes: 28073106,
  },
  "vision/part_31.onnx": {
    sha256: "b8fda4b241f913330a0029be2c601e214fb47b487827c7f24333302428c7f2a5",
    bytes: 28048527,
  },
  "vision/neck.onnx": {
    sha256: "0f8e19747bdc7e3b61731a4037aecd1ea9f563c817b2ab7f4f8b07e296aa0ad2",
    bytes: 13939490,
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

/** The tracker graphs under one base URL, for a dev page that serves them itself. */
export function localTracker(base: string): ModelManifest {
  const b = base.endsWith("/") ? base : base + "/";
  return Object.fromEntries(Object.entries(UNPUBLISHED_TRACKER).map(([name, e]) => [name, { ...e, url: b + name }]));
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
