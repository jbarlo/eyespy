/** MP4/MOV demuxing with mp4box.js. It reads only the boxes it needs (moov), then sample bytes on demand. */
import { DataStream, Endianness, MP4BoxBuffer, createFile } from "mp4box";
import type { Movie, Sample } from "mp4box";

export type VideoTrack = {
  brands: string[];
  codec: string; // RFC 6381 string from the sample entry, such as "hvc1.2.4.L123.B0"
  fourcc: string; // "hvc1", "avc1", ...
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array; // avcC / hvcC payload for VideoDecoder.configure
  timescale: number;
  duration: number; // seconds
  /** Display transform from the track matrix: [a, b, c, d] with x' = a·x + c·y, y' = b·x + d·y (before translation). */
  matrix: [number, number, number, number];
  created: Date | null;
  samples: Sample[]; // decode order
  /**
   * cts of the first presented sample; pts = (cts - ctsOrigin) / timescale puts the first frame at 0, as ffmpeg does.
   */
  ctsOrigin: number;
};

export async function demux(file: Blob): Promise<VideoTrack> {
  const mp4 = createFile();
  let ready = null as Movie | null; // mp4box callbacks set it; `as` keeps TS from narrowing it to null
  let error = null as string | null;
  mp4.onReady = (info) => (ready = info);
  mp4.onError = (_m, msg) => (error = msg);
  let pos = 0;
  const CHUNK = 4 << 20;
  // mp4box returns the next file position it wants, so a moov at the end is reached without reading the mdat
  while (!ready && !error && pos < file.size) {
    const ab = await file.slice(pos, Math.min(file.size, pos + CHUNK)).arrayBuffer();
    const b = MP4BoxBuffer.fromArrayBuffer(ab, pos);
    const next = mp4.appendBuffer(b, pos + ab.byteLength >= file.size);
    pos = next > pos ? next : pos + ab.byteLength;
  }
  if (error) throw new Error(`not a readable MP4/MOV: ${error}`);
  if (!ready) throw new Error("not an MP4/MOV file (no moov box)");
  const info = ready;
  const t = info.videoTracks[0];
  if (!t) throw new Error("no video track");
  const trak = mp4.getTrackById(t.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as Record<string, unknown> & { type: string };
  let description: Uint8Array | undefined;
  for (const k of ["avcC", "hvcC", "vpcC", "av1C"]) {
    const box = entry[k] as { write(s: DataStream): void } | undefined;
    if (box) {
      const s = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(s);
      description = new Uint8Array(s.buffer, 8); // drop the box header
      break;
    }
  }
  const samples = trak.samples;
  let ctsOrigin = Infinity;
  for (const s of samples) ctsOrigin = Math.min(ctsOrigin, s.cts);
  const m = Array.from(t.matrix as ArrayLike<number>).map((v) => v / 65536);
  const mat = (k: number) => {
    const v = m[k];
    if (v === undefined) throw new Error(`track matrix has only ${m.length} entries`);
    return Math.round(v);
  };
  const created = info.created && info.created.getUTCFullYear() > 1970 ? info.created : null;
  return {
    brands: info.brands,
    codec: t.codec,
    fourcc: entry.type,
    codedWidth: t.video?.width ?? 0,
    codedHeight: t.video?.height ?? 0,
    description,
    timescale: t.timescale,
    duration: t.duration / t.timescale,
    matrix: [mat(0), mat(1), mat(3), mat(4)],
    created,
    samples,
    ctsOrigin,
  };
}

/** Size of the displayed picture after the track's rotation. */
export function displaySize(t: VideoTrack): [number, number] {
  const [a, b] = t.matrix;
  return a === 0 && b !== 0 ? [t.codedHeight, t.codedWidth] : [t.codedWidth, t.codedHeight];
}

/** ffprobe's creation_time format ("2026-10-23T01:23:51.000000Z"). */
export const ffTime = (d: Date | null) => (d ? d.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z") : null);
