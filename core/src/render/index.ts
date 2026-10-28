/** The render module draws pictures for agents and people, with RGB in and out. It never stores anything. */
export type { FrameSource, TextDrawer } from "./ports.ts";
export type { Region, RenderError, Renderer } from "./types.ts";
export { createRenderer } from "./internal/renderer.ts";
