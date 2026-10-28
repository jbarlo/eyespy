import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decodeDetection } from "../../src/storage/internal/records.ts";
import type { NpyArray } from "../../src/storage/internal/npz.kernel.ts";
import {
  dosDateTime,
  packbits,
  readNpy,
  readNpz,
  unpackbits,
  writeNpy,
  writeNpz,
} from "../../src/storage/internal/npz.kernel.ts";
import { f16ToF32, f32ToF16 } from "../../src/pixels/index.ts";
import { zipTime } from "../compose.ts";
import { bytes, DIR, json, noiseBytes, sha256 } from "../fixtures/numerics/lib.ts";

type Meta = {
  npy: Record<string, { descr: string; shape: number[]; values: (number | string)[] }>;
  det: { mask_seed: number; w: number; h: number; emb_f16_sha256: string };
  packbits: { bits: number[]; packed: number[] }[];
};
const meta = json<Meta>("npz.json");
const unwrap = <T>(r: { isOk(): boolean; _unsafeUnwrap(): T }) => r._unsafeUnwrap();

const files = readdirSync(path.join(DIR, "npy")).filter((f) => f.endsWith(".npy"));
for (const f of files) {
  const name = f.replace(/\.npy$/, "");
  const want = meta.npy[name]!;
  test(`readNpy ${name}: dtype, shape, values as numpy wrote them; writeNpy = np.save bytes`, () => {
    const b = bytes(`npy/${f}`);
    const a = unwrap(readNpy(b));
    assert.equal(a.dtype, want.descr);
    assert.deepEqual(a.shape, want.shape);
    const got = [...a.data].map((v) => (typeof v === "bigint" ? v.toString() : v));
    const exp = want.values.map((v) => (typeof v === "string" && want.descr === "<f8" ? Number(v) : v));
    assert.deepEqual(got, exp);
    assert.deepEqual(writeNpy(a), b);
  });
}

test("a detection file written by numpy (savez_compressed, dino=1) decodes", () => {
  const { w, h, mask_seed } = meta.det;
  const d = decodeDetection(
    {
      id: "0.0" as never,
      frame: 0 as never,
      t: 0,
      run: "jar",
      prompt: "jar",
      score: 0.9,
      box: [10, 20, 10 + w, 20 + h],
    },
    bytes("det.npz"),
  )._unsafeUnwrap();
  const mask = Uint8Array.from(noiseBytes(mask_seed, w * h), (v) => (v > 127 ? 1 : 0));
  assert.deepEqual(d.mask, mask);
  assert.equal(
    d.area,
    mask.reduce((a, b) => a + b, 0),
  );
  assert.equal(sha256(f32ToF16(d.emb)), meta.det.emb_f16_sha256);
  assert.equal(d.region, null);
});

test("emb must be <f2; a short emb or a missing mask is a bad-record", () => {
  const emb = Float32Array.from({ length: 384 }, (_, i) => i / 384);
  const file = (arrays: [string, NpyArray][]) => writeNpz(arrays, 0);
  const m = {
    id: "1.2" as never,
    frame: 1 as never,
    t: 0.5,
    run: "a",
    prompt: "a",
    score: 1,
    box: [0, 0, 3, 3] as [number, number, number, number],
  };
  const mask: [string, NpyArray] = ["mask", { dtype: "|u1", shape: [2], data: Uint8Array.of(0xff, 0x80) }];
  const f2 = (v: Float32Array): [string, NpyArray] => ["emb", { dtype: "<f2", shape: [v.length], data: f32ToF16(v) }];
  const d = decodeDetection(m, file([mask, f2(emb)]))._unsafeUnwrap();
  assert.deepEqual([...d.emb], [...f16ToF32(f32ToF16(emb))]);
  assert.equal(d.area, 9);
  const f4 = decodeDetection(m, file([mask, ["emb", { dtype: "<f4", shape: [384], data: emb }]]));
  assert.deepEqual(f4._unsafeUnwrapErr(), {
    kind: "bad-record",
    file: "dets/1.2.npz",
    message: "emb dtype <f4 not supported",
  });
  const short = decodeDetection(m, file([mask, f2(Float32Array.of(1, 2, 3))]));
  assert.deepEqual(short._unsafeUnwrapErr(), { kind: "bad-record", file: "dets/1.2.npz", message: "emb has 3 values" });
  const noMask = decodeDetection(m, file([f2(emb)]));
  assert.equal(noMask._unsafeUnwrapErr().kind, "bad-record");
  assert.equal(decodeDetection(m, Uint8Array.of(1, 2, 3))._unsafeUnwrapErr().kind, "bad-record");
});

test("readNpz: uncompressed np.savez", () => {
  const z = unwrap(readNpz(bytes("plain.npz")));
  assert.deepEqual([...z.get("a")!.data], [0, 1, 2, 3, 4]);
  assert.deepEqual(z.get("b")!.shape, [2, 2]);
});

test("readNpy rejects non-npy, fortran order and unknown dtypes (as Err, not a throw)", () => {
  assert.match(readNpy(new Uint8Array(16))._unsafeUnwrapErr(), /not an npy file/);
  const f4 = bytes("npy/f4_2x2x2.npy");
  const patch = (from: string, to: string) =>
    Uint8Array.from(String.fromCharCode(...f4).replace(from, to), (c) => c.charCodeAt(0));
  assert.match(readNpy(patch("'fortran_order': False", "'fortran_order': True "))._unsafeUnwrapErr(), /fortran/);
  assert.match(readNpy(patch("<f4", "<c8"))._unsafeUnwrapErr(), /dtype <c8 not supported/);
});

for (const c of meta.packbits)
  test(`packbits/unpackbits ${c.bits.length} bits = np.packbits/np.unpackbits`, () => {
    assert.deepEqual([...packbits(Uint8Array.from(c.bits))], c.packed);
    assert.deepEqual([...unpackbits(Uint8Array.from(c.packed), c.bits.length)], c.bits);
  });

const arrays: [string, NpyArray][] = [
  ["mask", { dtype: "|u1", shape: [2], data: Uint8Array.of(0xa5, 0x80) }],
  ["emb", { dtype: "<f2", shape: [2], data: Uint16Array.of(0x3c00, 0x8001) }],
  ["dino", { dtype: "<i8", shape: [], data: BigInt64Array.of(2n) }],
];

test("writeNpz = recorded bytes for a given time (no wall clock / TZ)", () => {
  const ms = Date.UTC(2026, 9, 24, 13, 37, 42);
  const b = writeNpz(arrays, ms);
  assert.deepEqual(
    [createHash("sha256").update(b).digest("hex"), b.length],
    ["c58cb7ca3429b6d883331cb38f89e9f26b0a7261085aa62dd637ce63276709e8", 508],
  );
  assert.equal(zipTime(b), ms);
});

test("writeNpz bytes don't depend on the machine's time zone", () => {
  const ms = Date.UTC(2026, 2, 29, 1, 30, 0); // half an hour after Europe's spring-forward switch
  const saved = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utc = writeNpz(arrays, ms);
    for (const tz of ["Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata"]) {
      process.env.TZ = tz;
      assert.deepEqual(writeNpz(arrays, ms), utc, tz);
    }
    assert.equal(zipTime(utc), ms);
    assert.equal(dosDateTime(ms) >>> 16, ((2026 - 1980) << 9) | (3 << 5) | 29);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});
