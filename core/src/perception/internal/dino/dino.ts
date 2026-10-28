/**
 * DINOv2-small CLS embeddings, L2-normalised, in batches. `embed` crops regions first with `regionCrop`.
 * `appearance` takes images as they are. An empty input returns without loading the model.
 */
import type { ResultAsync } from "neverthrow";
import type { Mask, RGB } from "../../../pixels/index.ts";
import { sequence } from "../../../railway/index.ts";
import { APPEARANCE_DIM, MODEL_FILES, normalize, type Appearance } from "../../pure.ts";
import type { PerceptionError } from "../../types.ts";
import { float32Output, type Models } from "../models.ts";
import { DINO_SIZE, dinoBatch, regionCrop } from "./pixels.kernel.ts";

const BATCH = 32;

export interface Dino {
  readonly embed: (img: RGB, regions: readonly Mask[]) => ResultAsync<readonly Appearance[], PerceptionError>;
  /** One vector per crop, in order. */
  readonly appearance: (crops: readonly RGB[]) => ResultAsync<readonly Appearance[], PerceptionError>;
}

export function createDino(models: Models): Dino {
  const file = MODEL_FILES.appearance;

  const batch = (crops: readonly RGB[]): ResultAsync<readonly Appearance[], PerceptionError> =>
    models
      .run(file, {
        pixel_values: { type: "float32", data: dinoBatch(crops), dims: [crops.length, 3, DINO_SIZE, DINO_SIZE] },
      })
      .andThen((r) =>
        float32Output(r, file, "pooler_output", crops.length * APPEARANCE_DIM).map((v) =>
          crops.map((_, i) => normalize(v.slice(i * APPEARANCE_DIM, (i + 1) * APPEARANCE_DIM))),
        ),
      );

  const appearance = (crops: readonly RGB[]): ResultAsync<readonly Appearance[], PerceptionError> => {
    const batches = Array.from({ length: Math.ceil(crops.length / BATCH) }, (_, k) =>
      crops.slice(k * BATCH, (k + 1) * BATCH),
    );
    return sequence(batches, batch).map((vs) => vs.flat());
  };

  return {
    appearance,
    embed: (img, regions) => appearance(regions.map((r) => regionCrop(img, r))),
  };
}
