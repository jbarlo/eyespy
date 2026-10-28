/** Stepping through unassigned look-alike groups: the page shown and the label a new object would get. */
import { slice } from "./slice.ts";
import type { Group } from "./types.ts";

type TriagePage = {
  readonly offset: number;
  readonly total: number;
  readonly groupsTotal: number;
  readonly group: Group | null;
};

export type TriageState = { readonly page: TriagePage | null; readonly newLabel: string };

export const createTriageStore = () => slice<TriageState>(() => ({ page: null, newLabel: "" }));
