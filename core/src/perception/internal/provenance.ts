/** The manifest's model provenance. Its wording and keys are public API. */
import { ResultAsync } from "neverthrow";
import type { HostFailure, ModelRuntime } from "../../ports/index.ts";
import { hostFailure } from "../../ports/index.ts";
import { APPEARANCE_DIM, FEATURE_FORMAT, MODEL_FILES } from "../pure.ts";
import type { ModelFile, Provenance } from "../types.ts";

export function provenance(rt: ModelRuntime, detectorFile: string): ResultAsync<Provenance, HostFailure> {
  const file = (name: string): ResultAsync<ModelFile, HostFailure> =>
    ResultAsync.fromPromise(rt.sha256(name), (e) => hostFailure("runtime", "sha256", e)).map((sha256) => ({
      file: name,
      sha256,
    }));
  // One at a time, vision first. The adapter caches hashes, so the order only matters for its log.
  return file(MODEL_FILES.vision).andThen((vision) =>
    file(MODEL_FILES.text).andThen((text) =>
      file(detectorFile).andThen((detector) =>
        file(MODEL_FILES.appearance).map((appearance): Provenance => ({
          models: {
            segmentation: {
              name: "SAM 3",
              format: "onnx",
              export:
                "CardAnvilModels/sam3-ONNX (HF transformers Sam3Model split into vision/text/detector; Sign ops patched)",
              source_weights_sha256: "6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a",
              vision,
              text,
              detector,
              feature_cache: FEATURE_FORMAT,
            },
            appearance: {
              name: "facebook/dinov2-small",
              export: "onnx-community/dinov2-small fp32 + CLS gather",
              ...appearance,
              dim: APPEARANCE_DIM,
            },
          },
          runtime: rt.describe(),
        })),
      ),
    ),
  );
}
