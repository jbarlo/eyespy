/**
 * Worker side of the SAM License agreement, as defence in depth (the page decides).
 * Without `samLicenseAgreed`, the worker refuses every SAM 3 file before a network fetch or an OPFS cache read, which
 * also covers models cached before a licence change. `sha256` is a manifest lookup, not a read, so it stays allowed.
 */
import type { Model, ModelRuntime } from "eyespy-core/ports";
import { SAM_LICENSE_REFUSED } from "../../protocol.ts";

/**
 * Everything but DINOv2 (Apache-2.0) counts as SAM 3.
 * @internal
 */
export const underSamLicense = (name: string): boolean => !name.startsWith("dinov2-small/");

type Runtime = ModelRuntime & { prepare(names?: string[]): Promise<void> };

/** `rt`, refusing SAM 3 files unless `agreed`. `all` is the manifest, which prepare() fetches when given no names. */
export function guardSamModels(rt: Runtime, all: readonly string[], agreed: boolean): Runtime {
  const check = (name: string) => {
    if (!agreed && underSamLicense(name))
      throw new Error(`${SAM_LICENSE_REFUSED}: ${name} is under the SAM License; agree to it in the app first`);
  };
  return {
    load: async (name): Promise<Model> => {
      check(name);
      return rt.load(name);
    },
    readText: async (name) => {
      check(name);
      return rt.readText(name);
    },
    prepare: async (names) => {
      for (const n of names ?? all) check(n);
      return rt.prepare(names);
    },
    describe: () => rt.describe(),
    sha256: (name) => rt.sha256(name),
  };
}
