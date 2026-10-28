/**
 * The float32 detector feature planes, kept between detector calls instead of allocated per call. Otherwise a find
 * puts a fresh set through the GC for every keyframe and prompt.
 *
 * `take` hands out the kept set, or a new one if the kept set is out, so overlapping calls never share planes.
 * `give` returns it once the run has resolved. ORT doesn't keep feeds after `run`.
 */
import { FEATURE_PLANES } from "../../pure.ts";

export class PlanesPool {
  private kept: readonly Float32Array[] | null = null;

  take(): readonly Float32Array[] {
    const p = this.kept ?? FEATURE_PLANES.map(({ len }) => new Float32Array(len));
    this.kept = null;
    return p;
  }

  give(p: readonly Float32Array[]): void {
    this.kept = p;
  }
}
