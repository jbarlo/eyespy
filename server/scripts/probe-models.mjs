// Prints each ONNX model's inputs and outputs (name, type, dims) and checks that the WebGPU EP loads it.
// LD_LIBRARY_PATH=$EYESPY_VK_LIB node server/scripts/probe-models.mjs <model.onnx>...
import ort from "onnxruntime-node";
console.log("backends", ort.listSupportedBackends?.());
for (const p of process.argv.slice(2)) {
  const t = performance.now();
  const s = await ort.InferenceSession.create(p, { executionProviders: ["webgpu"], logSeverityLevel: 3 });
  console.log(p, Math.round(performance.now() - t), "ms");
  for (const [k, names] of [
    ["in", s.inputNames],
    ["out", s.outputNames],
  ]) {
    const meta = k === "in" ? s.inputMetadata : s.outputMetadata;
    names.forEach((n, i) => console.log(" ", k, n, JSON.stringify(meta?.[i] ?? meta?.[n])));
  }
  await s.release();
}
