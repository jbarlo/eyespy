/** Layout constants and the colour and colormap helpers clients use to draw their own overlays. Browser-safe. */
import type { Box } from "../pixels/index.ts";
import type { Rgb3 } from "../ports/index.ts";
import { color as colorKernel, JET as jetKernel } from "./internal/color.kernel.ts";
import { outline as outlineKernel } from "./internal/outline.kernel.ts";

/** Tiles per row of a frame grid. */
export const GRID_COLS = 6;
/** Crop-sheet tile side in pixels, and tiles per row. */
export const CROP_TILE = 240;
export const CROP_COLS = 8;
/** The most crops on one sheet. */
export const CROP_SHEET_MAX = 64;
/** Groups per page of `todo --groups`. */
export const GROUP_PAGE = 12;

/** A stable colour per key. */
export type Color = (key: string) => Rgb3;
/** The JET colormap, 256 × 3 bytes. */
export type Jet = Uint8Array;
export type Outline = (mask: Uint8Array, box: Box, W: number, H: number, thickness: number) => Int32Array;

export const color: Color = colorKernel;
/** A shared table. Do not write to it. */
export const JET: Jet = jetKernel;
/** @internal */
export const outline: Outline = outlineKernel;
