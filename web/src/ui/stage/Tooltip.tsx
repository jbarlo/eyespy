/** The hover tooltip. It has its own small store, so a pointer move re-renders only this component. */
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { TipState } from "./controller.ts";

export function Tooltip({ store }: { readonly store: StoreApi<TipState> }) {
  const tip = useStore(store, (s) => s.tip);
  if (!tip) return null;
  return (
    <div className="tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}
