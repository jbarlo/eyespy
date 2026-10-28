/**
 * What the user is pointing at: selected detections or object, the hovered region, the region-search box and its
 * result, and the answers computed for the selection ("which object is this?", look-alikes).
 */
import { slice } from "./slice.ts";
import type { Box, Match, SearchResult, Similar } from "./types.ts";

export type SelectionState = {
  readonly ids: readonly string[];
  readonly obj: string | null;
  readonly hover: string | null;
  readonly searchRect: Box | null;
  readonly searchResult: SearchResult | null;
  /** Ranked objects for the selection, keyed by the selection it was computed for. */
  readonly matches: {
    readonly key: string;
    readonly current: readonly string[];
    readonly list: readonly Match[];
  } | null;
  readonly similar: { readonly id: string; readonly list: readonly Similar[] } | null;
};

export const createSelectionStore = () =>
  slice<SelectionState>(() => ({
    ids: [],
    obj: null,
    hover: null,
    searchRect: null,
    searchResult: null,
    matches: null,
    similar: null,
  }));
