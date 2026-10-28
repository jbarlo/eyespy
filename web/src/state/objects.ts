/** What people decided: the objects (labels, members, best view) and the edit history with undo/redo state. */
import { color } from "eyespy-core/render/pure";
import { slice } from "./slice.ts";
import type { History, Obj } from "./types.ts";

export type ObjectsState = { readonly objects: readonly Obj[]; readonly history: History | null };

export const createObjectsStore = () => slice<ObjectsState>(() => ({ objects: [], history: null }));

/** An object's stable colour (the same as the CLI's renders). */
export const objColor = (oid: string) => `rgb(${color(oid).join(",")})`;
export const TODO_COLOR = "rgb(255,196,61)";
export const REJECT_COLOR = "rgb(239,68,68)";
/** The owner value data rows carry for rejected detections. */
export const REJECTED = "x";
