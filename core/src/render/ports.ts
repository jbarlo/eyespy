/** What render requires, in its own vocabulary. Video satisfies FrameSource and the host's ImageCodec TextDrawer. */
import type { Result, ResultAsync } from "neverthrow";
import type { RGB } from "../pixels/index.ts";
import type { TextItem } from "../ports/index.ts";
import type { FrameAccessError, FrameNo, NoKeyframe } from "../video/pure.ts";

export interface FrameSource {
  image(i: FrameNo): ResultAsync<RGB, FrameAccessError>;
  /** The frame tag drawn at top left. */
  tag(i: FrameNo): Result<string, NoKeyframe>;
}

export interface TextDrawer {
  /** Draws outlined text onto a copy of the image. */
  drawText(img: RGB, items: readonly TextItem[]): Promise<RGB>;
}

export type RenderPorts = { readonly frames: FrameSource; readonly text: TextDrawer };
