import type { Gray, RGB } from "../pixels/index.ts";

export type Rgb3 = readonly [number, number, number];

export type TextItem = {
  readonly text: string;
  /** Left of the baseline. */
  readonly x: number;
  /** Baseline. */
  readonly y: number;
  /** In pixels. */
  readonly size: number;
  readonly fill: Rgb3;
  readonly stroke: Rgb3;
  readonly strokeWidth: number;
};

export interface ImageCodec {
  decode(bytes: Uint8Array): Promise<RGB>;
  decodeGray(bytes: Uint8Array): Promise<Gray>;
  encodeJpeg(img: RGB, quality: number): Promise<Uint8Array>;
  encodePng(img: Gray): Promise<Uint8Array>;
  /** Draws outlined text into a new image and leaves the input as it was. */
  drawText(img: RGB, items: readonly TextItem[]): Promise<RGB>;
}
