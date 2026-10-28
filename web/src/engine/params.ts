/** The engine's page URL parameters, all optional, read in one place for the app and the ?debug page. */
import { localManifest, runtimeMirror, type ModelManifest, type RuntimeAssets } from "./manifest.ts";

export type PageParams = {
  readonly models: ModelManifest | undefined;
  readonly runtime: RuntimeAssets | undefined;
  readonly session: string | undefined;
  readonly detector: "fp16" | "fp32" | undefined;
};

export function pageParams(search: string): PageParams {
  const q = new URLSearchParams(search);
  const models = q.get("models"),
    runtime = q.get("runtime"),
    detector = q.get("detector");
  return {
    models: models ? localManifest(models) : undefined,
    runtime: runtime ? runtimeMirror(runtime) : undefined,
    session: q.get("session") ?? undefined,
    detector: detector === "fp16" || detector === "fp32" ? detector : undefined,
  };
}
