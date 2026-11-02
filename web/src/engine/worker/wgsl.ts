/**
 * Rewrites WGSL that onnxruntime-web generates into forms every browser's shader compiler accepts. The rewritten code
 * means the same, so every browser runs it, not only the one that needs it.
 */

// FIXME: Firefox's shader compiler (naga) types `bitcast<vec2<f16>>(u32)` as f32 and rejects the shader
// (https://github.com/gfx-rs/wgpu/issues/8896), which breaks ORT's f16 Pad. Remove this rewrite once Firefox ships a
// naga with that fixed.
const BITCAST = "bitcast<vec2<f16>>(";

/** `bitcast<vec2<f16>>(x)` as `vec2<f16>(unpack2x16float(x))`: the same two halves of x. @internal */
export function portableWgsl(code: string): string {
  let out = "";
  let i = 0;
  for (let at = code.indexOf(BITCAST); at >= 0; at = code.indexOf(BITCAST, i)) {
    const start = at + BITCAST.length;
    let depth = 1;
    let j = start;
    for (; j < code.length && depth > 0; j++) depth += code[j] === "(" ? 1 : code[j] === ")" ? -1 : 0;
    if (depth > 0) break;
    out += `${code.slice(i, at)}vec2<f16>(unpack2x16float(${code.slice(start, j - 1)}))`;
    i = j;
  }
  return out + code.slice(i);
}

type ShaderDescriptor = { code: string };
type DeviceProto = { createShaderModule: (this: unknown, d: ShaderDescriptor) => unknown };
const INSTALLED = Symbol.for("eyespy.portableWgsl");

/** Sends every shader created on `proto` (GPUDevice's, by default) through portableWgsl. Installing twice is a no-op. */
export function installPortableWgsl(
  proto = (globalThis as { GPUDevice?: { prototype: DeviceProto } }).GPUDevice?.prototype,
) {
  if (!proto || INSTALLED in proto) return;
  const create = proto.createShaderModule;
  proto.createShaderModule = function (this: unknown, d: ShaderDescriptor) {
    return create.call(this, { ...d, code: portableWgsl(d.code) });
  };
  Object.defineProperty(proto, INSTALLED, { value: true });
}
