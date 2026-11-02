import assert from "node:assert/strict";
import { test } from "node:test";
import { installPortableWgsl, portableWgsl } from "../src/engine/worker/wgsl.ts";

test("portableWgsl: an f16 pair bitcast becomes unpack2x16float, nested parentheses kept, other code untouched", () => {
  assert.equal(
    portableWgsl("let c =\n      bitcast<vec2<f16>>(uniforms.constant_value)[0];"),
    "let c =\n      vec2<f16>(unpack2x16float(uniforms.constant_value))[0];",
  );
  assert.equal(
    portableWgsl("a(bitcast<vec2<f16>>(u[i32(k)] + f(1u)), bitcast<vec2<f16>>(x))"),
    "a(vec2<f16>(unpack2x16float(u[i32(k)] + f(1u))), vec2<f16>(unpack2x16float(x)))",
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
  assert.deepEqual(seen, ["Pad: vec2<f16>(unpack2x16float(v))"]);
});
