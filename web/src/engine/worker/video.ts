/**
 * ClipSource for picked video files. It decodes with WebCodecs only when the codec is on our allow-list AND the
 * browser's VideoDecoder accepts the exact codec string and decodes the first frame. It refuses anything else with an
 * "unsupported" event and the add fails, since the app ships no software decoder.
 */
import type { ClipFormat, ClipSource } from "eyespy-core/ports";
import { contentKeyOf } from "eyespy-core/video/pure";
import type { EngineEvent } from "../../protocol.ts";
import { frameLuma, framePlanes, fullRangeLuma, orientGray, resizeGrayBicubic, rgbaJpegStyle } from "./color.ts";
import { demux, displaySize, ffTime, type VideoTrack } from "./mp4.ts";

/** What we decode natively, if the browser agrees. One row per codec family. */
const ALLOWED = [
  { name: "H.264/AVC", containers: ["mp4", "mov"], fourcc: ["avc1", "avc3"] },
  { name: "HEVC/H.265", containers: ["mp4", "mov"], fourcc: ["hvc1", "hev1"] },
] as const;

const codecName = (fourcc: string) =>
  ALLOWED.find((r) => (r.fourcc as readonly string[]).includes(fourcc))?.name ??
  ({ vp09: "VP9", av01: "AV1", mp4v: "MPEG-4 Part 2", apcn: "ProRes", apch: "ProRes" } as Record<string, string>)[
    fourcc
  ] ??
  fourcc;

type Plan = { track: VideoTrack; config: VideoDecoderConfig; w: number; h: number; captured: string | null };

type VideoHost = { emit(e: EngineEvent): void };

export class WebVideo implements ClipSource {
  private files = new Map<string, File>();
  private plans = new Map<string, Promise<Plan>>();

  constructor(private host: VideoHost) {}

  /** Make a picked File addressable by the core; returns its ref (the file name, de-duplicated). */
  register(file: File): string {
    let ref = file.name,
      n = 1;
    const same = (f?: File) => !!f && f.size === file.size && f.lastModified === file.lastModified;
    while (this.files.has(ref) && !same(this.files.get(ref))) ref = `${file.name} (${++n})`;
    this.files.set(ref, file);
    return ref;
  }

  private file(ref: string): File {
    const f = this.files.get(ref);
    if (!f) throw new Error(`no such file: ${ref} (pick the video again)`);
    return f;
  }

  resolve(ref: string) {
    return ref;
  }
  async exists(ref: string) {
    return this.files.has(ref);
  }

  async size(ref: string) {
    return this.file(ref).size;
  }
  async readRange(ref: string, start: number, end: number) {
    return new Uint8Array(await this.file(ref).slice(start, end).arrayBuffer());
  }

  async key(ref: string) {
    return (await contentKeyOf(this, ref)).match(
      (k) => k,
      (e) => {
        throw new Error(e.message);
      },
    );
  }

  private plan(ref: string): Promise<Plan> {
    let p = this.plans.get(ref);
    if (!p) {
      p = this.makePlan(ref);
      this.plans.set(ref, p);
      p.catch(() => this.plans.delete(ref));
    }
    return p;
  }

  private async makePlan(ref: string): Promise<Plan> {
    const file = this.file(ref);
    let track: VideoTrack | null = null;
    let codec = "unknown",
      name = "unknown",
      reason = "";
    try {
      track = await demux(file);
      codec = track.codec;
      name = codecName(track.fourcc);
    } catch (e) {
      reason = `container not supported (only MP4/MOV are read natively): ${(e as Error).message}`;
    }
    if (track) {
      const container = track.brands.includes("qt  ") ? "mov" : "mp4";
      const row = ALLOWED.find(
        (r) =>
          (r.containers as readonly string[]).includes(container) &&
          (r.fourcc as readonly string[]).includes(track.fourcc),
      );
      if (!row) reason = `${name} (${codec}) is not on the list of codecs decoded natively`;
      else {
        const config: VideoDecoderConfig = {
          codec,
          codedWidth: track.codedWidth,
          codedHeight: track.codedHeight,
          description: track.description,
        };
        const ok =
          typeof VideoDecoder !== "undefined" &&
          (await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported;
        if (!ok) reason = `this browser can't decode ${name} (${codec})`;
        else if (!(await decodesFirstFrame(file, track, config)))
          reason = `this browser accepted ${name} (${codec}) but failed to decode it`;
        else {
          const [w, h] = displaySize(track);
          return { track, config, w, h, captured: ffTime(track.created) };
        }
      }
    }
    this.host.emit({ kind: "unsupported", file: file.name, codec, codecName: name, reason });
    throw new Error(`${file.name}: ${reason}`);
  }

  async open(ref: string): Promise<ClipFormat> {
    const p = await this.plan(ref);
    return { w: p.w, h: p.h, captured: p.captured, timing: { kind: "video" } };
  }

  async grayStream(ref: string, fps: number, w: number, h: number): Promise<Uint8Array> {
    const p = await this.plan(ref);
    const t = performance.now();
    const out = await webcodecsGray(this.file(ref), p.track, p.config, fps, w, h, (f) =>
      this.host.emit({ kind: "progress", file: ref, stage: "keyframes", fraction: f }),
    );
    this.host.emit({
      kind: "log",
      text: `webcodecs: grey stream of ${out.length / (w * h)} frames in ${((performance.now() - t) / 1000).toFixed(1)}s`,
    });
    return out;
  }

  async frameJpeg(ref: string, t: number): Promise<Uint8Array> {
    const p = await this.plan(ref);
    return webcodecsFrame(this.file(ref), p.track, p.config, t);
  }
}

/** Sample bytes through a sliding window (samples are mostly increasing in file offset in decode order). */
class SampleReader {
  private start = 0;
  private buf = new Uint8Array(0);
  constructor(private file: Blob) {}
  async read(offset: number, size: number): Promise<Uint8Array> {
    if (offset < this.start || offset + size > this.start + this.buf.length) {
      this.start = offset;
      this.buf = new Uint8Array(
        await this.file.slice(offset, Math.min(this.file.size, offset + Math.max(size, 8 << 20))).arrayBuffer(),
      );
    }
    return this.buf.subarray(offset - this.start, offset - this.start + size);
  }
}

const usOf = (t: VideoTrack, cts: number) => Math.round(((cts - t.ctsOrigin) / t.timescale) * 1e6);

async function chunkOf(r: SampleReader, t: VideoTrack, i: number) {
  const s = t.samples[i];
  if (!s) throw new Error(`no sample ${i} (track has ${t.samples.length})`);
  return new EncodedVideoChunk({
    type: s.is_sync ? "key" : "delta",
    timestamp: usOf(t, s.cts),
    duration: Math.round((s.duration / t.timescale) * 1e6),
    data: await r.read(s.offset, s.size),
  });
}

async function decodesFirstFrame(file: Blob, t: VideoTrack, config: VideoDecoderConfig): Promise<boolean> {
  let got = false,
    failed = false;
  const dec = new VideoDecoder({
    output: (f) => {
      got = true;
      f.close();
    },
    error: () => (failed = true),
  });
  try {
    dec.configure(config);
    const r = new SampleReader(file);
    // a few samples, so decoders with reordering delay emit something before flush
    for (let i = 0; i < Math.min(t.samples.length, 4); i++) dec.decode(await chunkOf(r, t, i));
    await dec.flush();
  } catch {
    failed = true;
  } finally {
    if (dec.state !== "closed") dec.close();
  }
  return got && !failed;
}

/** Feed samples [from, to) in decode order with backpressure; frames arrive in presentation order on `output`. */
async function feed(
  dec: VideoDecoder,
  r: SampleReader,
  t: VideoTrack,
  from: number,
  to: number,
  onFed?: (i: number) => void,
  failed?: () => Error | null,
) {
  for (let i = from; i < to; i++) {
    while (dec.decodeQueueSize > 16) await new Promise((res) => dec.addEventListener("dequeue", res, { once: true }));
    const err = failed?.();
    if (err) throw err;
    dec.decode(await chunkOf(r, t, i));
    onFed?.(i);
  }
  await dec.flush();
}

/** Draws a source (fw×fh, coded orientation) upright at w×h by applying the track rotation or flip, then scaling. */
function drawUpright(
  g: OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource,
  fw: number,
  fh: number,
  t: VideoTrack,
  w: number,
  h: number,
) {
  const [a, b, c, d] = t.matrix;
  const xs = [0, a * fw, c * fh, a * fw + c * fh],
    ys = [0, b * fw, d * fh, b * fw + d * fh];
  const tx = -Math.min(...xs),
    ty = -Math.min(...ys);
  const rw = Math.max(...xs) + tx,
    rh = Math.max(...ys) + ty;
  const sx = w / rw,
    sy = h / rh;
  g.setTransform(a * sx, b * sy, c * sx, d * sy, tx * sx, ty * sy);
  g.drawImage(src, 0, 0, fw, fh);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * A decoded frame as a canvas (coded orientation) with Node-pipeline colours. Formats we can't unpack fall back to the
 * browser's colour-managed drawImage.
 */
async function frameCanvas(f: VideoFrame): Promise<{ cv: OffscreenCanvas; w: number; h: number; native: boolean }> {
  const p = await framePlanes(f);
  const w = p?.w ?? f.displayWidth,
    h = p?.h ?? f.displayHeight;
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext("2d")!;
  if (p) g.putImageData(rgbaJpegStyle(p), 0, 0);
  else g.drawImage(f, 0, 0, w, h);
  return { cv, w, h, native: !p };
}

/**
 * Matches ffmpeg's `-vf fps=F,scale=W:H -pix_fmt gray`. Output slot n (time n/F) shows the last frame whose pts rounds
 * to n, or else the latest earlier frame. The last frame fills slots up to the end of its duration. The output is
 * full-range luma scaled with swscale-style bicubic; only frame formats we cannot unpack use canvas scaling.
 */
async function webcodecsGray(
  file: Blob,
  t: VideoTrack,
  config: VideoDecoderConfig,
  fps: number,
  w: number,
  h: number,
  progress: (f: number) => void,
) {
  const small = new OffscreenCanvas(w, h);
  const g = small.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  const out: Uint8Array[] = [];
  let pending: VideoFrame | null = null;
  let next = 0;
  let lastEnd = 0;
  // the converter copies frames out (VideoFrame.copyTo) in order while decoding goes on
  let chain: Promise<void> = Promise.resolve();
  const grayOf = async (f: VideoFrame) => {
    const p = await frameLuma(f);
    if (p) {
      // as in ffmpeg, full-range luma, rotated, then swscale-style bicubic (sharpness ranking depends on the filter)
      const up = orientGray(fullRangeLuma(p), p.w, p.h, t.matrix);
      return resizeGrayBicubic(up.data, up.w, up.h, w, h);
    }
    const { cv, w: fw, h: fh } = await frameCanvas(f);
    drawUpright(g, cv, fw, fh, t, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const y = new Uint8Array(w * h);
    for (let p = 0; p < y.length; p++) y[p] = d[p * 4]!;
    return y;
  };
  /** `pending` fills slots next to slot-1. Returns whether the converter took it (the converter then closes it). */
  const emitUntil = (slot: number) => {
    if (!pending || slot <= next) return false;
    const f = pending,
      n = slot - next;
    next = slot;
    chain = chain.then(async () => {
      try {
        const y = await grayOf(f);
        for (let k = 0; k < n; k++) out.push(y);
      } finally {
        f.close();
      }
    });
    return true;
  };
  let err = null as Error | null; // the decoder callbacks set it; `as` keeps TS from narrowing it to null
  const dec = new VideoDecoder({
    output: (f) => {
      const pts = f.timestamp / 1e6;
      const k = Math.round(pts * fps + 1e-9); // AV_ROUND_NEAR_INF
      lastEnd = pts + (f.duration ?? 0) / 1e6;
      if (pending && !emitUntil(k)) pending.close();
      pending = null;
      if (k < next)
        f.close(); // that slot is already filled
      else pending = f;
    },
    error: (e) => (err = e instanceof Error ? e : new Error(String(e))),
  });
  dec.configure(config);
  try {
    const r = new SampleReader(file);
    const n = t.samples.length;
    await feed(
      dec,
      r,
      t,
      0,
      n,
      (i) => i % 60 === 0 && progress(i / n),
      () => err,
    );
    if (err) throw err;
    if (!emitUntil(Math.max(next + 1, Math.round(lastEnd * fps)))) (pending as VideoFrame | null)?.close();
    pending = null;
    await chain;
  } finally {
    (pending as VideoFrame | null)?.close();
    if (dec.state !== "closed") dec.close();
  }
  progress(1);
  const all = new Uint8Array(out.length * w * h);
  out.forEach((f, i) => all.set(f, i * w * h));
  return all;
}

/** Matches ffmpeg's `-ss t` (accurate seek), returning the first frame with pts ≥ t as an upright full-size JPEG. */
async function webcodecsFrame(file: Blob, t: VideoTrack, config: VideoDecoderConfig, sec: number): Promise<Uint8Array> {
  const target = Math.round(sec * 1e6);
  const S = t.samples;
  if (!S.length) throw new Error("track has no samples");
  // every index below stays in 0 to S.length-1 (want is a found index or the reduce's), hence the `!`s
  // find the wanted sample in presentation order, then go back to its sync sample in decode order
  let want = -1;
  for (let i = 0; i < S.length; i++) {
    const us = usOf(t, S[i]!.cts);
    if (us >= target - 1 && (want < 0 || us < usOf(t, S[want]!.cts))) want = i;
  }
  if (want < 0) want = S.reduce((b, s, i) => (s.cts > S[b]!.cts ? i : b), 0); // past the end, take the last frame
  let from = want;
  while (from > 0 && !S[from]!.is_sync) from--;
  let to = want + 1; // plus reordering lookahead up to the next sync sample
  while (to < S.length && !S[to]!.is_sync && to < want + 32) to++;
  const wantUs = usOf(t, S[want]!.cts);
  let frame = null as VideoFrame | null;
  let err = null as Error | null; // the decoder callbacks set it; `as` keeps TS from narrowing it to null
  const dec = new VideoDecoder({
    output: (f) => {
      if (!frame && f.timestamp === wantUs) frame = f;
      else f.close();
    },
    error: (e) => (err = e instanceof Error ? e : new Error(String(e))),
  });
  dec.configure(config);
  try {
    await feed(dec, new SampleReader(file), t, from, to, undefined, () => err);
  } finally {
    if (dec.state !== "closed") dec.close();
  }
  if (err) throw err;
  if (!frame) throw new Error(`no frame decoded at ${sec}s`);
  const f = frame;
  try {
    const { cv, w: fw, h: fh } = await frameCanvas(f);
    const [w, h] = displaySize(t);
    const up = new OffscreenCanvas(w, h);
    const g = up.getContext("2d")!;
    g.imageSmoothingEnabled = false; // a pure rotation copies pixels exactly
    drawUpright(g, cv, fw, fh, t, w, h);
    return new Uint8Array(await (await up.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
  } finally {
    f.close();
  }
}
