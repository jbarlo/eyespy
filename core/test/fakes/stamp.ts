/** Clip number and time as four solid grey blocks; block centres keep their exact values through the 1008² resize. */
export type FrameStamp = { clip: number; t: number };

export const STAMP_BLOCKS = 4;

/** The stamp band covers the top tenth of a frame; objects are drawn below it. */
export const stampBand = (h: number) => Math.max(2, Math.round(h / 10));

/** The four block values: clip, time in centiseconds (2 bytes), check byte. */
export function stampBytes({ clip, t }: FrameStamp): number[] {
  const cs = Math.round(t * 100);
  const b = [clip & 0xff, (cs >> 8) & 0xff, cs & 0xff] as const;
  return [...b, 0x5a ^ b[0] ^ b[1] ^ b[2]];
}

/** Decode a stamp from its four block values; null when they don't form one, as in a crop of a frame. */
export function decodeStamp(v: readonly number[]): FrameStamp | null {
  const [c, hi, lo, check] = v;
  if (c === undefined || hi === undefined || lo === undefined || check === undefined) return null;
  if (c < 1 || (0x5a ^ c ^ hi ^ lo) !== check) return null;
  return { clip: c, t: ((hi << 8) | lo) / 100 };
}

/** Where to sample block k of the stamp in an image of width w and height h (centre of the block). */
export function stampPoint(k: number, w: number, h: number): [number, number] {
  return [Math.floor(((k + 0.5) * w) / STAMP_BLOCKS), Math.floor(h / 20)];
}
