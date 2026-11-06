/** Memory tokens between float32 values that bfloat16 can hold exactly and their bfloat16 bits. */

/** The upper half of each value's float32 bits. */
export function bf16Bits(v: Float32Array): Uint16Array {
  const bits = new Uint32Array(v.buffer, v.byteOffset, v.length);
  const out = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = bits[i]! >>> 16;
  return out;
}

export function bf16Floats(b: Uint16Array): Float32Array {
  const out = new Float32Array(b.length);
  const bits = new Uint32Array(out.buffer);
  for (let i = 0; i < b.length; i++) bits[i] = b[i]! << 16;
  return out;
}
