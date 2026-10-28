/** Arguments and options several commands share (jimkit-cli specs). */

export const frames = {
  type: "string",
  short: "f",
  argName: "spec",
  description: "Keyframe indices, e.g. 3-10,15 (default: all)",
} as const;
export const threshold = {
  type: "number",
  short: "t",
  description: "Score threshold (default: session config)",
} as const;
export const crops = {
  type: "boolean",
  short: "c",
  description: "Image is a close-up sheet of each detection instead of frame overlays",
} as const;
export const objArg = { type: "string", required: true, description: "Object id, e.g. o3" } as const;
export const ids = (description: string) => ({ type: "string", required: true, variadic: true, description }) as const;
export const k = (n: number, description: string) => ({ type: "number", short: "k", default: n, description }) as const;
export const frameArg = { type: "number", required: true, description: "Keyframe index" } as const;
export const boxArg = { type: "string", required: true, description: "x0,y0,x1,y1 in full-res pixels" } as const;

/** Parses "x0,y0,x1,y1" into four numbers, or returns null. An empty part is not 0. */
export const parseBox = (s: string): readonly [number, number, number, number] | null => {
  const parts = s.split(",");
  if (parts.some((p) => p.trim() === "")) return null;
  const [x0, y0, x1, y1, ...rest] = parts.map(Number);
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined || rest.length) return null;
  const box = [x0, y0, x1, y1] as const;
  return box.some(Number.isNaN) ? null : box;
};
