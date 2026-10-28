type TensorType = "float32" | "float16" | "int64";
type TensorData = Float32Array | Uint16Array | BigInt64Array;
/** A plain host-memory tensor. `data` is the caller's buffer, and a model never writes into its feeds. */
export type Tensor = {
  readonly type: TensorType;
  readonly data: TensorData;
  readonly dims: readonly number[];
};
export type Feeds = Readonly<Record<string, Tensor>>;

/** A loaded model. Inputs and outputs are plain host-memory tensors. */
export interface Model {
  run(feeds: Feeds): Promise<Feeds>;
}

export type RuntimeInfo = { readonly runtime: string; readonly version: string; readonly device: string };

export interface ModelRuntime {
  /** `name` is relative to the model directory, such as "vision_fp16.onnx". */
  load(name: string): Promise<Model>;
  /** Small model-side files (tokenizer.json). */
  readText(name: string): Promise<string>;
  /** What runs the models, for the manifest's provenance. */
  describe(): RuntimeInfo;
  /** Content hash of a model file. The adapter caches it. */
  sha256(name: string): Promise<string>;
}
