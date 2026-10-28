/**
 * How the user views the canvas: tool, layers, threshold, prompts. The store is app-scoped, but opening a session sets
 * the threshold again from its config.
 */
import { slice } from "./slice.ts";
import type { Layers, ToolId } from "./types.ts";

export type LayersState = {
  readonly tool: ToolId;
  readonly layers: Layers;
  readonly threshold: number;
  readonly prompt: string;
  readonly semPrompt: string;
};

export const createLayersStore = () =>
  slice<LayersState>(() => ({
    tool: "select",
    layers: { objects: true, todo: true, rejects: false, semantic: false, gaps: false },
    threshold: 0.5,
    prompt: "",
    semPrompt: "",
  }));
