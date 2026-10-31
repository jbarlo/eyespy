import type { ResultAsync } from "neverthrow";
import type { Box, Gray, NonEmpty, RGB } from "../pixels/index.ts";
import type { HostFailure, Rgb3 } from "../ports/index.ts";
import type { FrameAccessError, FrameNo } from "../video/pure.ts";
import type { RenderPorts } from "./ports.ts";

/** What render needs to draw a detection. A `Detection` satisfies it. */
export type Region = {
  readonly id: string;
  readonly frame: FrameNo;
  readonly t: number;
  readonly score: number;
  readonly box: Box;
  /** 0/1 values, cropped to the box. */
  readonly mask: Uint8Array;
};

type OverlayOptions = {
  /** Display scale of the output. */
  readonly scale: number;
  /** Label per region id. Defaults to the id. */
  readonly labels?: ReadonlyMap<string, string>;
  /** Colour per region id. Defaults to `color(id)`. */
  readonly colors?: ReadonlyMap<string, Rgb3>;
};

type HeatTintOptions = {
  /** Heat above which a pixel counts as activated (config `active`). */
  readonly active: number;
  /** Frame mask (w×h, 0/1) of pixels to zero before tinting, such as assigned or rejected regions, or null. */
  readonly covered?: Uint8Array | null;
};
type HeatTint = { readonly image: RGB; readonly activeFraction: number };

export type RenderError = FrameAccessError | HostFailure;

export interface Renderer {
  /** Blends masks 50% with their outlines, scales, then draws labels and the frame tag. */
  overlay(i: FrameNo, regions: readonly Region[], opts: OverlayOptions): ResultAsync<RGB, RenderError>;
  /** Draws the frame tag, plus `extra`, onto an already scaled image. */
  tagged(img: RGB, i: FrameNo, extra?: string): ResultAsync<RGB, RenderError>;
  /**
   * Tiles resized to the first one's size, `cols` per row (default GRID_COLS). With several rows, the last row is
   * padded with black.
   */
  grid(tiles: NonEmpty<RGB>, cols?: number): RGB;
  /** Full-res crop around a region with its outline, padded for context. */
  cropRegion(r: Region): ResultAsync<RGB, RenderError>;
  /** CROP_TILE² tiles, each a labelled cropRegion. The default label is "<id> <t>s <score>". */
  cropTiles(regions: readonly Region[], labels?: readonly string[]): ResultAsync<readonly RGB[], RenderError>;
  /** cropTiles of the first `limit` (default CROP_SHEET_MAX, null for all) in a CROP_COLS grid, or null for none. */
  cropSheet(
    regions: readonly Region[],
    labels?: readonly string[],
    limit?: number | null,
  ): ResultAsync<RGB | null, RenderError>;
  /**
   * One CROP_COLS row of best views per group, the first tile labelled "<gid> n=<k> <id>" and the rest "<id> <place>"
   * (`placeOf`; `photo` marks a photo's region), or null for none.
   */
  groupSheet(
    groups: readonly { readonly id: string; readonly regions: readonly (Region & { readonly photo?: true })[] }[],
  ): ResultAsync<RGB | null, RenderError>;
  /**
   * Tints the frame with the heatmap in JET, after resizing the heatmap to the frame as cv2 does. Also returns
   * the fraction of the area that is activated.
   */
  heatTint(img: RGB, heat: Gray, opts: HeatTintOptions): HeatTint;
  /** Darkens covered pixels to `factor` of their value. */
  darken(img: RGB, covered: Uint8Array, factor: number): RGB;
  /** Display scale, bilinear, with the size rounded. */
  scale(img: RGB, s: number): RGB;
}

export type CreateRenderer = (ports: RenderPorts) => Renderer;
