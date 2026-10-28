/**
 * The pixels module is the one leaf with no domain logic. It has byte buffers, boxes and 0/1 masks. Every op returns
 * a new buffer except `paste` and the f16 conversions given an `out`. The whole folder is a kernel.
 */
import type { NonEmpty } from "./types.ts";

export type { Box, Gray, Mask, MeasuredMask, NonEmpty, RGB, Shape } from "./types.ts";

export const isNonEmpty = <T>(xs: readonly T[]): xs is NonEmpty<T> => xs.length > 0;

export { blank, crop, cropBox, hstack, paste, vstack } from "./internal/bytes.kernel.ts";
export { dilate, fromRunLengths, maskArea, maskIou, paintMasks, runLengths } from "./internal/mask.kernel.ts";
export { f16ToF32, f32ToF16, /** @internal */ f32ToF16Bits } from "./internal/f16.kernel.ts";
