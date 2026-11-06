import assert from "node:assert/strict";
import { test } from "node:test";
import { installPortableWgsl, portableWgsl } from "../src/engine/worker/wgsl.ts";

test("portableWgsl: an f16 pair bitcast unpacks its bits as a u32, nested parentheses kept, other code untouched", () => {
  assert.equal(
    portableWgsl("let c =\n      bitcast<vec2<f16>>(uniforms.constant_value)[0];"),
    "let c =\n      vec2<f16>(unpack2x16float(bitcast<u32>(uniforms.constant_value)))[0];",
  );
  // ORT's f16 Clip keeps its bounds in an f32 uniform, which unpack2x16float alone rejects
  assert.equal(
    portableWgsl("attr: f32; clamp(a, vec4<f16>(bitcast<vec2<f16>>(uniforms.attr)[0]))"),
    "attr: f32; clamp(a, vec4<f16>(vec2<f16>(unpack2x16float(bitcast<u32>(uniforms.attr)))[0]))",
  );
  assert.equal(
    portableWgsl("a(bitcast<vec2<f16>>(u[i32(k)] + f(1u)), bitcast<vec2<f16>>(x))"),
    "a(vec2<f16>(unpack2x16float(bitcast<u32>(u[i32(k)] + f(1u)))), vec2<f16>(unpack2x16float(bitcast<u32>(x))))",
  );
  for (const same of ["bitcast<output_value_t>(uniforms.constant_value);", "bitcast<vec2<f16>>(unclosed", ""])
    assert.equal(portableWgsl(same), same);
});

test("installPortableWgsl: shaders created on the prototype are rewritten, once however often it is installed", () => {
  const seen: string[] = [];
  class Device {
    createShaderModule(d: { code: string; label?: string }) {
      seen.push(`${d.label}: ${d.code}`);
      return this;
    }
  }
  installPortableWgsl(Device.prototype);
  installPortableWgsl(Device.prototype);
  const dev = new Device();
  assert.equal(dev.createShaderModule({ label: "Pad", code: "bitcast<vec2<f16>>(v)" }), dev);
  assert.deepEqual(seen, ["Pad: vec2<f16>(unpack2x16float(bitcast<u32>(v)))"]);
});
