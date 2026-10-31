/**
 * createRenderer builds the Renderer over its two ports. It only composes Results, layout and text items. Agents
 * read the label and tag text, so its formats, positions and sizes are public API.
 */
import type { Result } from "neverthrow";
import { ResultAsync } from "neverthrow";
import type { NonEmpty, RGB } from "../../pixels/index.ts";
import { blank, hstack, isNonEmpty, vstack } from "../../pixels/index.ts";
import type { Rgb3, TextItem } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import { at, got, invariant } from "../../invariant/index.ts";
import { sequence } from "../../railway/index.ts";
import type { FrameNo, NoKeyframe } from "../../video/pure.ts";
import { placeOf } from "../../video/pure.ts";
import type { RenderPorts } from "../ports.ts";
import { CROP_COLS, CROP_SHEET_MAX, CROP_TILE, GRID_COLS } from "../pure.ts";
import type { CreateRenderer, Region, RenderError, Renderer } from "../types.ts";
import { color } from "./color.kernel.ts";
import { blendOutlined, cropOutlined, darken, heatTint, letterbox } from "./paint.kernel.ts";
import { resizeRGB, scaleRGB } from "./resize.kernel.ts";

const BLACK: Rgb3 = [0, 0, 0];
const WHITE: Rgb3 = [255, 255, 255];
const YELLOW: Rgb3 = [255, 255, 0];

/** Outline thickness of overlay masks and of crop outlines. */
const OVERLAY_THICKNESS = 3;
const CROP_THICKNESS = 2;

// cv2.FONT_HERSHEY_SIMPLEX at scale s has a cap height of about 22·s px. An SVG sans font needs about 30·s px.
const fontPx = (scale: number) => Math.round(30 * scale);

const outlined = (text: string, x: number, y: number, scale: number, fill: Rgb3, strokeWidth: number): TextItem => ({
  text,
  x,
  y,
  size: fontPx(scale),
  fill,
  stroke: BLACK,
  strokeWidth,
});

/** Splits into consecutive runs of `n`. The last may be shorter. */
const chunks = <T>(xs: readonly T[], n: number): readonly NonEmpty<T>[] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, k) => {
    const c = xs.slice(k * n, k * n + n);
    invariant(isNonEmpty(c), "chunks: empty chunk");
    return c;
  });

/** A region with the label drawn on its crop tile. */
type Tile = { readonly region: Region; readonly label: string };

/** Distinct frames of `tiles` in first-use order, each with the indices of the tiles cut from it. */
const byFrame = (tiles: readonly Tile[]): readonly { readonly frame: FrameNo; readonly ks: readonly number[] }[] =>
  [...new Set(tiles.map((t) => t.region.frame))].map((frame) => ({
    frame,
    ks: tiles.flatMap((t, k) => (t.region.frame === frame ? [k] : [])),
  }));

/** The region box padded by 15% of its longer side, clamped to the frame. */
const paddedBox = (r: Region, w: number, h: number) => {
  const [x0, y0, x1, y1] = r.box;
  const pad = Math.trunc(0.15 * Math.max(x1 - x0, y1 - y0));
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w, x1 + pad), Math.min(h, y1 + pad)] as const;
};

export const createRenderer: CreateRenderer = ({ frames, text }: RenderPorts): Renderer => {
  const draw = ResultAsync.fromThrowable(
    (img: RGB, items: readonly TextItem[]) => text.drawText(img, items),
    (e) => hostFailure("codec", "drawText", e),
  );

  /** The frame tag at top left, yellow on black. */
  const tagItem = (i: FrameNo, extra: string): Result<TextItem, NoKeyframe> =>
    frames.tag(i).map((t) => outlined(t + extra, 8, 34, 1.0, YELLOW, 4));

  const grid = (tiles: NonEmpty<RGB>, cols: number = GRID_COLS): RGB => {
    const [t0] = tiles;
    const fitted = tiles.map((t) => resizeRGB(t, t0.w, t0.h));
    const short = fitted.length > cols ? (cols - (fitted.length % cols)) % cols : 0;
    const padded = [...fitted, ...Array.from({ length: short }, () => blank(t0.w, t0.h))];
    const rows = chunks(padded, cols).map(hstack);
    invariant(isNonEmpty(rows), "grid: no rows");
    return vstack(rows);
  };

  /** cropRegion's crop of `r` from an already read frame. */
  const crop = (img: RGB, r: Region): RGB => cropOutlined(img, paddedBox(r, img.w, img.h), r, CROP_THICKNESS, YELLOW);

  const cropRegion = (r: Region): ResultAsync<RGB, RenderError> => frames.image(r.frame).map((img) => crop(img, r));

  /**
   * Labelled CROP_TILE² tiles in tile order, in two phases. First it reads each distinct frame once, in first-use
   * order, cuts and letterboxes all its tiles, and lets the frame go. Then it draws the labels in tile order. A
   * sheet decodes each frame once however its tiles mix frames, which matters because video keeps few decoded.
   */
  const labelledTiles = (tiles: readonly Tile[]): ResultAsync<readonly RGB[], RenderError> =>
    sequence(byFrame(tiles), ({ frame, ks }) =>
      frames
        .image(frame)
        .map((img) => ks.map((k) => [k, letterbox(crop(img, at(tiles, k).region), CROP_TILE)] as const)),
    ).andThen((cut) => {
      const boxed = new Map(cut.flat());
      return sequence(tiles, ({ label }, k) => draw(got(boxed, k), [outlined(label, 6, 22, 0.6, WHITE, 3)]));
    });

  const cropTiles = (regions: readonly Region[], labels?: readonly string[]) =>
    labelledTiles(
      regions.map((r, k) => ({ region: r, label: labels?.[k] ?? `${r.id} ${r.t.toFixed(1)}s ${r.score.toFixed(2)}` })),
    );

  return {
    overlay: (i, regions, { scale, labels, colors }) =>
      frames.image(i).andThen((src) => {
        const painted = regions.map((r) => ({ box: r.box, mask: r.mask, color: colors?.get(r.id) ?? color(r.id) }));
        const out = scaleRGB(blendOutlined(src, painted, OVERLAY_THICKNESS), scale);
        const items = regions.map((r) =>
          outlined(
            labels?.get(r.id) ?? r.id,
            Math.trunc(r.box[0] * scale) + 4,
            Math.trunc(r.box[1] * scale) + 26,
            0.8,
            WHITE,
            4,
          ),
        );
        return tagItem(i, "").asyncAndThen((tag) => draw(out, [...items, tag]));
      }),

    tagged: (img, i, extra = "") => tagItem(i, extra).asyncAndThen((tag) => draw(img, [tag])),

    grid,
    cropRegion,
    cropTiles,

    cropSheet: (regions, labels, limit = CROP_SHEET_MAX) =>
      cropTiles(limit === null ? regions : regions.slice(0, limit), labels).map((tiles) =>
        isNonEmpty(tiles) ? grid(tiles, CROP_COLS) : null,
      ),

    groupSheet: (groups) => {
      // All rows' tiles go through one labelledTiles call, so a frame shared by several groups is read once.
      const rows = groups.map(({ id, regions }) =>
        regions.slice(0, CROP_COLS).map((r, k): Tile => ({
          region: r,
          label: k === 0 ? `${id} n=${regions.length} ${r.id}` : `${r.id} ${placeOf(r)}`,
        })),
      );
      const starts = rows.map((_, g) => rows.slice(0, g).reduce((n, row) => n + row.length, 0));
      return labelledTiles(rows.flat()).map((tiles) => {
        const padded = rows.flatMap((row, g) => {
          const start = starts[g] ?? 0;
          return [
            ...tiles.slice(start, start + row.length),
            ...Array.from({ length: CROP_COLS - row.length }, () => blank(CROP_TILE, CROP_TILE)),
          ];
        });
        return isNonEmpty(padded) ? grid(padded, CROP_COLS) : null;
      });
    },

    heatTint: (img, heat, { active, covered = null }) => {
      const t = heatTint(img, heat, active, covered);
      return { image: t.image, activeFraction: t.active / (img.w * img.h) };
    },

    darken,
    scale: scaleRGB,
  };
};
