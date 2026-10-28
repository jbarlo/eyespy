/** RGB with 8 bits per channel, row-major, without padding. */
export type RGB = { readonly w: number; readonly h: number; readonly data: Uint8Array };
/** One channel, 8 bits. */
export type Gray = { readonly w: number; readonly h: number; readonly data: Uint8Array };
/** x0, y0, x1, y1 in full-resolution pixels, covering [x0, x1) × [y0, y1). */
export type Box = readonly [number, number, number, number];
/** A 0/1 mask cropped to its box (`mask.length === boxW * boxH`). */
export type Mask = { readonly box: Box; readonly mask: Uint8Array };
/** A mask with its set-pixel count, counted once by whoever makes the mask. */
export type MeasuredMask = Mask & { readonly area: number };
/** Frame size as stored, [h, w]. */
export type Shape = readonly [number, number];
export type NonEmpty<T> = readonly [T, ...T[]];
