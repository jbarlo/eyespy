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
  /** Frees the model's memory, where the host can. The model isn't used again. */
  release?(): Promise<void>;
}

/** One graph of a chain: the file, the input it reads, and the only output it gives. */
export type ChainStep = { readonly file: string; readonly input: string; readonly output: string };

/** Graphs run one after another, each on the last one's output, with their memory freed as a set. */
export interface ModelChain {
  /** Runs every step on the first step's input and returns the last step's output as a host tensor. */
  run(first: Tensor): Promise<Tensor>;
  release(): Promise<void>;
}

export type RuntimeInfo = { readonly runtime: string; readonly version: string; readonly device: string };

export interface ModelRuntime {
  /** `name` is relative to the model directory, such as "vision_fp16.onnx". */
  load(name: string): Promise<Model>;
  /**
   * The steps loaded as a chain the host runs in its own way, so that a GPU host can keep the tensors between steps on
   * the GPU and let its queue drain. A host without it gets its steps run through `load`, on host tensors.
   */
  loadChain?(steps: readonly ChainStep[]): Promise<ModelChain>;
  /** Small model-side files (tokenizer.json). */
  readText(name: string): Promise<string>;
  /** What runs the models, for the manifest's provenance. */
  describe(): RuntimeInfo;
  /** Content hash of a model file. The adapter caches it. */
  sha256(name: string): Promise<string>;
}
