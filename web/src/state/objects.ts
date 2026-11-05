/** What people decided: the objects (labels, members, best view) and the edit history with undo/redo state. */
import { color } from "eyespy-core/render/pure";
import { slice } from "./slice.ts";
import type { History, Obj } from "./types.ts";

export type ObjectsState = { readonly objects: readonly Obj[]; readonly history: History | null };

export const createObjectsStore = () => slice<ObjectsState>(() => ({ objects: [], history: null }));

/** An object's stable colour (the same as the CLI's renders). */
export const objColor = (oid: string) => `rgb(${color(oid).join(",")})`;
/** An object as people read it, label first: `zucchini · calm-otter`. */
export const objName = (o: { readonly id: string; readonly label?: string | undefined }) =>
  o.label ? `${o.label} · ${o.id}` : o.id;
/**
 * The object someone typed or chose: its datalist line, an id (first word, in any case), then a label, whole or in part.
 * The datalist line comes first, because labels can repeat and only the id tells them apart.
 */
export const pickObject = (objects: readonly Obj[], typed: string): string | undefined => {
  const t = typed.trim().toLowerCase();
  const first = t.split(/\s|·/)[0];
  return (
    objects.find((o) => objName(o).toLowerCase() === t) ??
    objects.find((o) => o.id === first) ??
    objects.find((o) => o.label.toLowerCase() === t) ??
    objects.find((o) => o.label.toLowerCase().includes(t))
  )?.id;
};
export const TODO_COLOR = "rgb(255,196,61)";
export const REJECT_COLOR = "rgb(239,68,68)";
/** The owner value data rows carry for rejected detections. */
export const REJECTED = "x";
