/** ModelRuntime over onnxruntime-node, on the WebGPU EP (Dawn on Vulkan), or on the CPU EP with --cpu. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ort from "onnxruntime-node";
import type { Model, ModelRuntime, Tensor } from "eyespy-core/ports";

/**
 * An ORT output as the port's Tensor. It accepts only the types the models emit and checks their data, since this is
 * the edge. fp16 data may arrive as a Float16Array when the runtime has one. The port carries its bits as a
 * Uint16Array.
 * @internal
 */
export function fromOrt(name: string, v: { type: string; data: unknown; dims: readonly number[] }): Tensor {
  const dims = [...v.dims];
  const d = v.data;
  if (v.type === "float32" && d instanceof Float32Array) return { type: "float32", data: d, dims };
  if (v.type === "int64" && d instanceof BigInt64Array) return { type: "int64", data: d, dims };
  if (v.type === "float16" && d instanceof Uint16Array) return { type: "float16", data: d, dims };
  if (v.type === "float16" && ArrayBuffer.isView(d) && d.constructor.name === "Float16Array")
    return { type: "float16", data: new Uint16Array(d.buffer, d.byteOffset, d.byteLength / 2), dims };
  throw new Error(`model output ${name}: unsupported tensor type ${v.type} (${Object.prototype.toString.call(d)})`);
}

export class OrtRuntime implements ModelRuntime {
  constructor(
    readonly dir: string,
    readonly device: "webgpu" | "cpu" = "webgpu",
  ) {}

  async load(name: string): Promise<Model> {
    const p = path.join(this.dir, name);
    if (!existsSync(p)) throw new Error(`model file missing: ${p} (set EYESPY_MODELS)`);
    const s = await ort.InferenceSession.create(p, {
      executionProviders: this.device === "cpu" ? ["cpu"] : ["webgpu"],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    return {
      async run(feeds) {
        const f: Record<string, ort.Tensor> = {};
        for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor(v.type, v.data, v.dims);
        const r = await s.run(f);
        const out: Record<string, Tensor> = {};
        for (const [k, v] of Object.entries(r)) out[k] = fromOrt(k, v);
        return out;
      },
    };
  }

  async readText(name: string) {
    return readFileSync(path.join(this.dir, name), "utf8");
  }

  describe() {
    return {
      runtime: "onnxruntime-node",
      version: ort.env.versions?.node ?? "1.30.0",
      device: this.device === "webgpu" ? "webgpu (Dawn/Vulkan)" : "cpu",
    };
  }

  /** sha256 of a model file, cached in a `<file>.sha256` stamp next to it. */
  async sha256(name: string): Promise<string> {
    const p = path.join(this.dir, name);
    const stamp = `${p}.sha256`;
    if (existsSync(stamp) && statSync(stamp).mtimeMs >= statSync(p).mtimeMs) return readFileSync(stamp, "utf8").trim();
    const h = createHash("sha256");
    await new Promise<void>((res, rej) =>
      createReadStream(p)
        .on("data", (c) => h.update(c))
        .on("end", res)
        .on("error", rej),
    );
    const hex = h.digest("hex");
    writeFileSync(stamp, hex);
    return hex;
  }
}
