/** The canvas component renders chrome only; drawing and pointer input live in its controller, outside React. */
import { useEffect, useRef, useState } from "react";
import { createStore } from "zustand/vanilla";
import { objColor, REJECT_COLOR, TODO_COLOR } from "../../state/index.ts";
import { useApp, useDerived, useSlice } from "../context.tsx";
import { createStageController } from "./controller.ts";
import type { TipState } from "./controller.ts";
import { toolOf } from "./tools.ts";
import { Tooltip } from "./Tooltip.tsx";

export function Stage() {
  const app = useApp();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [tip] = useState(() => createStore<TipState>()(() => ({ tip: null })));
  const f = useDerived((s) => s.currentFrame());
  const nvis = useDerived((s) => s.visible().length);
  const tool = useSlice("layers", (s) => s.tool);
  const handle = useSlice("stage", (s) => s.handle);

  useEffect(() => {
    const canvas = cv.current,
      box = wrap.current;
    if (!canvas || !box) return;
    const ctl = createStageController({ canvas, wrap: box, app, tip });
    return ctl.dispose;
  }, [app, tip]);

  return (
    <div className="stage" ref={wrap}>
      <canvas
        ref={cv}
        role="img"
        aria-label={f ? `Keyframe ${f.frame} at ${f.t.toFixed(1)} s, ${nvis} regions shown` : "No keyframe"}
        style={{ cursor: toolOf(tool).cursor }}
      />
      <Tooltip store={tip} />
      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" title="Zoom out (-)" aria-label="Zoom out" onClick={() => handle?.zoom(1 / 1.25)}>
          −
        </button>
        <button type="button" title="Fit to view (0)" aria-label="Fit to view" onClick={() => handle?.fit()}>
          Fit
        </button>
        <button type="button" title="Zoom in (+)" aria-label="Zoom in" onClick={() => handle?.zoom(1.25)}>
          +
        </button>
      </div>
      <div className="legend" aria-hidden="true">
        <span>
          <i style={{ background: TODO_COLOR }} />
          unassigned
        </span>
        <span>
          <i style={{ background: objColor("o1") }} />
          object
        </span>
        <span>
          <i style={{ background: REJECT_COLOR }} />
          rejected
        </span>
      </div>
    </div>
  );
}
