/**
 * ClipSource over a folder of JPEG or PNG frames, read with sharp. eyespy never decodes video itself. All frames must
 * be one size once upright. With `fps` the folder is a `rate` clip (frame i at i / fps), else `stills` (photos). A
 * `rate` folder is sampled with video/pure's `sampleAt` and `frameAt`.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import type { ClipFormat, ClipSource, OpenOptions, Timing } from "eyespy-core/ports";
import { describeFramesError, frameAt, frameFiles, framesKey, sampleAt, sampleCount } from "eyespy-core/video/pure";

const JPEG_QUALITY = 95;

type Frame = { readonly file: string; readonly format: "jpeg" | "png"; readonly orientation: number };
type Folder = { readonly frames: readonly Frame[]; readonly timing: Exclude<Timing, { kind: "video" }> };

/** Runs at most `limit` calls of `fn` at once and returns the results in input order. */
async function mapLimit<T, R>(xs: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The frame files of folder `dir` (absolute paths), or a thrown error saying why it isn't a clip. */
async function listFrames(dir: string): Promise<readonly string[]> {
  if (!(await stat(dir)).isDirectory())
    throw new Error(`${dir} is a file; a clip is a folder of frames (extract them first, see the README)`);
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
  return frameFiles(names).match(
    (fs) => fs.map((n) => path.join(dir, n)),
    (e) => {
      throw new Error(describeFramesError(dir, e));
    },
  );
}

async function sha1File(file: string): Promise<string> {
  const h = createHash("sha1");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

export class FramesFolder implements ClipSource {
  private readonly folders = new Map<string, Folder>();

  /** `concurrency` is how many frames to read at once. sharp also uses threads inside each read. */
  constructor(private readonly concurrency = 4) {}

  resolve(ref: string) {
    return path.resolve(ref);
  }
  async exists(ref: string) {
    return existsSync(ref);
  }

  async key(ref: string) {
    const files = await listFrames(ref);
    const digests = await mapLimit(files, this.concurrency, async (f) => ({
      name: path.basename(f),
      sha1: await sha1File(f),
    }));
    return framesKey(digests);
  }

  async open(ref: string, opts: OpenOptions): Promise<ClipFormat> {
    if (opts.fps !== null && !(Number.isFinite(opts.fps) && opts.fps > 0))
      throw new Error(`fps must be a positive number, got ${opts.fps}`);
    const files = await listFrames(ref);
    const heads = await mapLimit(files, this.concurrency * 2, async (file) => {
      const m = await sharp(file)
        .metadata()
        .catch((e: unknown) => {
          throw new Error(`${path.basename(file)} in ${ref}: not a readable image (${message(e)})`);
        });
      if (m.format !== "jpeg" && m.format !== "png")
        throw new Error(`${path.basename(file)} in ${ref}: a ${m.format} image, not JPEG or PNG`);
      const orientation = m.orientation ?? 1;
      const turned = orientation >= 5;
      return {
        frame: { file, format: m.format, orientation } satisfies Frame,
        exif: m.exif,
        w: turned ? m.height : m.width,
        h: turned ? m.width : m.height,
      };
    });
    const [first] = heads;
    if (!first) throw new Error(`no frames in ${ref}`);
    const odd = heads.find((x) => x.w !== first.w || x.h !== first.h);
    if (odd)
      throw new Error(
        `frames in ${ref} differ in size: ${path.basename(first.frame.file)} is ${first.w}×${first.h}, ` +
          `${path.basename(odd.frame.file)} is ${odd.w}×${odd.h} (upright); a clip's frames are all one size`,
      );
    const count = heads.length;
    const timing: Folder["timing"] =
      opts.fps === null ? { kind: "stills", count } : { kind: "rate", fps: opts.fps, count };
    this.folders.set(ref, { frames: heads.map((x) => x.frame), timing });
    return { w: first.w, h: first.h, captured: exifCaptured(first.exif), timing };
  }

  private folder(ref: string): Folder {
    const f = this.folders.get(ref);
    if (!f) throw new Error(`${ref} was not opened`);
    return f;
  }

  async grayStream(ref: string, fps: number, w: number, h: number): Promise<Uint8Array> {
    const { frames, timing } = this.folder(ref);
    const count = frames.length;
    const picks: number[] = [];
    if (timing.kind === "stills") picks.push(...frames.keys());
    else {
      if (fps > timing.fps) throw new Error(`grey stream at ${fps} fps from frames at ${timing.fps} fps`);
      const n = sampleCount(fps, timing.fps, count);
      for (let s = 0; s < n; s++) picks.push(sampleAt(s, fps, timing.fps, count));
    }
    const out = new Uint8Array(picks.length * w * h);
    await mapLimit(picks, this.concurrency, async (i, n) => {
      const frame = frames[i];
      if (!frame) throw new Error(`no frame ${i}`);
      out.set(await grey(frame.file, w, h), n * w * h);
    });
    return out;
  }

  async frameJpeg(ref: string, t: number): Promise<Uint8Array> {
    const { frames, timing } = this.folder(ref);
    const i =
      timing.kind === "rate"
        ? frameAt(t, timing.fps, frames.length)
        : Math.min(Math.max(0, Math.round(t)), frames.length - 1);
    const frame = frames[i];
    if (!frame) throw new Error(`no frame at ${t} in ${ref}`);
    if (frame.format === "jpeg" && frame.orientation === 1) return new Uint8Array(await readFile(frame.file));
    return new Uint8Array(await sharp(frame.file).rotate().jpeg({ quality: JPEG_QUALITY }).toBuffer());
  }
}

/**
 * EXIF DateTimeOriginal, with OffsetTimeOriginal when present, from a JPEG's EXIF block as sharp returns it ("Exif\0\0"
 * + TIFF). Returns ISO 8601, either "2026-10-23T01:23:51" (local time, as the camera wrote it) or "...+01:00". Null
 * when absent or malformed. @internal
 */
export function exifCaptured(exif: Uint8Array | undefined): string | null {
  if (!exif || exif.length < 14) return null;
  const tiff = new DataView(exif.buffer, exif.byteOffset + 6, exif.byteLength - 6);
  const head = String.fromCharCode(exif[6]!, exif[7]!);
  if (head !== "II" && head !== "MM") return null;
  const le = head === "II";
  const n = tiff.byteLength;
  const u16 = (o: number) => (o + 2 <= n ? tiff.getUint16(o, le) : -1);
  const u32 = (o: number) => (o + 4 <= n ? tiff.getUint32(o, le) : -1);
  const entries = (ifd: number) => {
    const count = u16(ifd);
    const out = new Map<number, { type: number; count: number; at: number }>();
    for (let i = 0; i < Math.max(0, count); i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > n) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const ascii = (e: { type: number; count: number; at: number } | undefined) => {
    if (!e || e.type !== 2 || e.count <= 0) return null;
    const start = e.count <= 4 ? e.at : u32(e.at);
    if (start < 0 || start + e.count > n) return null;
    return String.fromCharCode(...new Uint8Array(tiff.buffer, tiff.byteOffset + start, e.count))
      .replace(/\0.*$/, "")
      .trim();
  };
  const exifIfd = entries(u32(4)).get(0x8769);
  if (!exifIfd) return null;
  const sub = entries(u32(exifIfd.at));
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(ascii(sub.get(0x9003)) ?? "");
  if (!m || m[1] === "0000") return null;
  const offset = ascii(sub.get(0x9011));
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset && /^[+-]\d\d:\d\d$/.test(offset) ? offset : ""}`;
}

/** A frame upright, scaled to w×h (bicubic), as 8-bit luma (full-range BT.601 weights, as JPEG's Y). */
async function grey(file: string, w: number, h: number): Promise<Uint8Array> {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(w, h, { fit: "fill", kernel: "cubic" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== w || info.height !== h) throw new Error(`${file}: scaled to ${info.width}×${info.height}`);
  const c = info.channels;
  const y = new Uint8Array(w * h);
  if (c === 1) y.set(data.subarray(0, w * h));
  else
    for (let p = 0; p < y.length; p++)
      y[p] = Math.round(0.299 * data[p * c]! + 0.587 * data[p * c + 1]! + 0.114 * data[p * c + 2]!);
  return y;
}
