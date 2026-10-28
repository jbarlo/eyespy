/** The data shapes the UI shows, derived from the router's outputs, plus the UI's own vocabulary. */
import type { Outputs, SessionLocation, UnsupportedVideo } from "../engine/port.ts";

export type { SessionLocation, UnsupportedVideo };
export type Frame = Outputs["data"]["frames"]["frames"][number];
/** A data.dets row as the router returns it (mask and aliases when asked for). */
export type DetRow = Outputs["data"]["dets"]["dets"][number];
/** A detection without its mask (masks are loaded per frame into the detections store). */
export type Det = Omit<DetRow, "mask"> & { readonly object?: string };
export type Obj = Outputs["data"]["objects"]["objects"][number];
export type Run = Outputs["data"]["runs"]["runs"][number];
export type History = Outputs["data"]["history"];
export type Status = Outputs["status"];
export type Clip = Outputs["clips"]["list"]["clips"][number];
export type Match = Outputs["obj"]["match"]["matches"][number];
export type SearchResult = Outputs["search"];
export type AddResult = Outputs["add"];
export type Box = readonly [x0: number, y0: number, x1: number, y1: number];
/** data.dets's RLE mask over the detection's box (core's runLengths). */
export type Rle = Extract<NonNullable<DetRow["mask"]>, { readonly format: "rle" }>;
export type Mask = { readonly rle: Rle; readonly aliases: readonly string[] };
export type Similar = {
  readonly id: string;
  readonly frame: number;
  readonly t: number;
  readonly score: number;
  readonly box: Box;
  readonly object?: string;
  readonly sim: number;
};
export type Group = { readonly group: string; readonly ids: readonly string[]; readonly frames: string };
export type ToolId = "select" | "rect" | "search";
export type LayerId = "objects" | "todo" | "rejects" | "semantic" | "gaps";
export type Layers = Readonly<Record<LayerId, boolean>>;
export type Detector = "fp32" | "fp16";
/** One browser (OPFS) session folder's bytes, and how many of them are re-encodable image features. */
export type SessionUsage = { readonly name: string; readonly total: number; readonly features: number };
/** What the storage walk measures: the browser's estimate for the site, the models cache, every OPFS session. */
export type Usage = {
  readonly usage: number;
  readonly quota: number;
  readonly models: number;
  readonly sessions: readonly SessionUsage[];
  readonly persisted: boolean;
};
/** One region computeVisible returns. */
export type Visible = { readonly det: Det; readonly kind: "object" | "todo" | "reject"; readonly color: string };
