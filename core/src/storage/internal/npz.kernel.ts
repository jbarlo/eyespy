/**
 * Reads and writes numpy .npy and .npz files, and implements np.packbits. Zip entry times come from the caller and
 * are written as UTC fields, so the bytes don't depend on the wall clock or the machine's time zone.
 */
import { unzipSync, zipSync } from "fflate";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";

type NpyData = Uint8Array | Uint16Array | Float32Array | Int32Array | BigInt64Array | Float64Array;
export type NpyArray = { readonly dtype: string; readonly shape: readonly number[]; readonly data: NpyData };

const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** @internal */
export function readNpy(buf: Uint8Array): Result<NpyArray, string> {
  if (buf.length < 10 || buf[0] !== 0x93 || latin1(buf.subarray(1, 6)) !== "NUMPY") return err("not an npy file");
  const major = buf[6];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (major !== 1 && buf.length < 12) return err("truncated npy header");
  const hlen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const hstart = major === 1 ? 10 : 12;
  if (hstart + hlen > buf.length) return err("truncated npy header");
  const header = latin1(buf.subarray(hstart, hstart + hlen));
  const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  if (dtype === undefined) return err(`npy header has no descr: ${header}`);
  if (/'fortran_order':\s*True/.test(header)) return err("fortran-order npy not supported");
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (shapeText === undefined) return err(`npy header has no shape: ${header}`);
  const shape = shapeText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const raw = buf.slice(hstart + hlen); // a copy, so it is aligned and owned
  const ab = raw.buffer;
  const width = (n: number) => raw.byteLength % n === 0;
  const data: NpyData | null =
    dtype === "|u1" || dtype === "|b1" || dtype === "<u1"
      ? raw
      : dtype === "<f2" && width(2)
        ? new Uint16Array(ab)
        : dtype === "<f4" && width(4)
          ? new Float32Array(ab)
          : dtype === "<f8" && width(8)
            ? new Float64Array(ab)
            : dtype === "<i4" && width(4)
              ? new Int32Array(ab)
              : dtype === "<i8" && width(8)
                ? new BigInt64Array(ab)
                : null;
  if (!data) return err(`npy dtype ${dtype} not supported`);
  return ok({ dtype, shape, data });
}

/** @internal */
export function writeNpy(a: NpyArray): Uint8Array {
  let h = `{'descr': '${a.dtype}', 'fortran_order': False, 'shape': (${a.shape.join(", ")}${a.shape.length === 1 ? "," : ""}), }`;
  h += " ".repeat(63 - ((10 + h.length) % 64)) + "\n";
  const body = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const out = new Uint8Array(10 + h.length + body.length);
  out[0] = 0x93;
  for (let i = 0; i < 5; i++) out[1 + i] = "NUMPY".charCodeAt(i);
  out[6] = 1;
  out[7] = 0;
  out[8] = h.length & 0xff;
  out[9] = h.length >> 8;
  for (let i = 0; i < h.length; i++) out[10 + i] = h.charCodeAt(i);
  out.set(body, 10 + h.length);
  return out;
}

export function readNpz(buf: Uint8Array): Result<ReadonlyMap<string, NpyArray>, string> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch (e) {
    return err(`not a zip file (${e instanceof Error ? e.message : String(e)})`);
  }
  const out = new Map<string, NpyArray>();
  for (const [name, data] of Object.entries(files)) {
    const a = readNpy(data);
    if (a.isErr()) return err(`${name}: ${a.error}`);
    out.set(name.replace(/\.npy$/, ""), a.value);
  }
  return ok(out);
}

/** The DOS date/time fields a zip entry stores, from ms since the epoch read as UTC. @internal */
export function dosDateTime(ms: number): number {
  const d = new Date(ms);
  const y = Math.max(0, d.getUTCFullYear() - 1980);
  return (
    ((y << 25) |
      ((d.getUTCMonth() + 1) << 21) |
      (d.getUTCDate() << 16) |
      (d.getUTCHours() << 11) |
      (d.getUTCMinutes() << 5) |
      (d.getUTCSeconds() >> 1)) >>>
    0
  );
}

/**
 * Works like np.savez_compressed, at deflate level 6. Every entry's time is `ms` as UTC. fflate reads local time,
 * so this overwrites its fields in the local headers and the central directory afterwards.
 */
export function writeNpz(arrays: ReadonlyArray<readonly [string, NpyArray]>, ms: number): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [k, a] of arrays) files[`${k}.npy`] = writeNpy(a);
  const zip = zipSync(files, { level: 6 });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const t = dosDateTime(ms);
  let off = 0;
  while (off + 30 <= zip.length && dv.getUint32(off, true) === 0x04034b50) {
    dv.setUint32(off + 10, t, true);
    off += 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true) + dv.getUint32(off + 18, true);
  }
  while (off + 46 <= zip.length && dv.getUint32(off, true) === 0x02014b50) {
    dv.setUint32(off + 12, t, true);
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
  return zip;
}

// np.packbits and np.unpackbits, in big-endian bit order

export function packbits(m: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(m.length / 8));
  for (let i = 0; i < m.length; i++) if (m[i]) out[i >> 3]! |= 0x80 >> (i & 7);
  return out;
}

export function unpackbits(p: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (p[i >> 3]! >> (7 - (i & 7))) & 1;
  return out;
}
