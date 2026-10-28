/**
 * ModelRuntime over onnxruntime-web (WebGPU EP). Model files and ORT's own wasm go through the hash cache.
 * ORT gets the wasm as bytes (env.wasm.wasmBinary), so it doesn't fetch it again per load.
 */
import * as ort from "onnxruntime-web/webgpu";
import type { Model, ModelRuntime, Tensor } from "eyespy-core/ports";
import type { ModelEntry, ModelManifest } from "../manifest.ts";
import type { DownloadCache } from "./cache.ts";

export class WebModelRuntime implements ModelRuntime {
  private adapterInfo = "webgpu";
  private ortReady?: Promise<void>;

  constructor(
    private manifest: ModelManifest,
    private ortWasm: ModelEntry,
    private cache: DownloadCache,
  ) {
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1;
    ort.env.webgpu.powerPreference = "high-performance";
    ort.env.logLevel = "error";
  }

  private entry(name: string): ModelEntry {
    const e = this.manifest[name];
    if (!e) throw new Error(`model file ${name} is not in the manifest`);
    return e;
  }

  bytes(name: string): Promise<Uint8Array> {
    return this.cache.bytes(name, this.entry(name));
  }

  /** ORT's wasm, cached like a model. It must be in place before the first session starts. */
  private ensureOrt() {
    this.ortReady ??= this.cache.bytes("onnxruntime wasm", this.ortWasm).then((b) => {
      ort.env.wasm.wasmBinary = b;
    });
    this.ortReady.catch(() => (this.ortReady = undefined));
    return this.ortReady;
  }

  /** Download and cache ORT's wasm and the named files (the whole manifest by default) ahead of use. */
  async prepare(names = Object.keys(this.manifest)) {
    await this.ensureOrt();
    for (const n of names) await this.bytes(n);
  }

  async load(name: string): Promise<Model> {
    await this.ensureOrt();
    const data = await this.bytes(name);
    const s = await ort.InferenceSession.create(data, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    });
    return {
      async run(feeds) {
        const f: Record<string, ort.Tensor> = {};
        for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor(v.type, v.data, v.dims);
        const r = await s.run(f);
        const out: Record<string, Tensor> = {};
        for (const [k, v] of Object.entries(r))
          out[k] = { type: v.type as Tensor["type"], data: v.data as Tensor["data"], dims: [...v.dims] };
        return out;
      },
    };
  }

  async readText(name: string) {
    return new TextDecoder().decode(await this.bytes(name));
  }

  async probeAdapter() {
    type Adapter = { info: { vendor: string; architecture: string; device: string; description: string } };
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o: object): Promise<Adapter | null> } }).gpu;
    const a = await gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!a) throw new Error("WebGPU is not available in this browser (no adapter)");
    const i = a.info;
    this.adapterInfo = `webgpu (${[i.vendor, i.architecture, i.device || i.description].filter(Boolean).join(" ")})`;
    return this.adapterInfo;
  }

  describe() {
    return { runtime: "onnxruntime-web", version: ort.env.versions?.web ?? "1.30.0", device: this.adapterInfo };
  }

  /** The cache checks every file against the manifest before use, so the manifest's hash is the file's hash. */
  async sha256(name: string) {
    return this.entry(name).sha256;
  }
}
