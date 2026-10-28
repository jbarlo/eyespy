/** Regions on this frame: a DOM mirror of the canvas, for keyboard users and agents. */
import type { Det } from "../../state/index.ts";
import { Panel } from "../common.tsx";
import { useActions, useDerived, useSlice } from "../context.tsx";
import { useOwnerText } from "./owner.ts";

export function FrameDetsPanel() {
  const a = useActions();
  const vis = useDerived((s) => s.visible());
  const ids = useSlice("selection", (s) => s.ids);
  const ownerText = useOwnerText();
  const sel = new Set(ids);
  return (
    <Panel id="frame-dets" title="Regions on this frame" badge={vis.length} open={false}>
      {!vis.length && <p className="muted">Nothing shown here. Run Find, or turn on more layers.</p>}
      <ul className="list" aria-label="Regions on this frame">
        {vis.map(({ det: d, kind, color }: { det: Det; kind: string; color: string }) => (
          <li key={d.id}>
            <button
              type="button"
              className={`det-row${sel.has(d.id) ? " on" : ""}`}
              aria-pressed={sel.has(d.id)}
              data-det-id={d.id}
              onClick={(e) => (e.shiftKey ? a.toggleSelect(d.id) : a.select([d.id]))}
              onMouseEnter={() => a.setHover(d.id)}
              onMouseLeave={() => a.setHover(null)}
            >
              <i className="sw" style={{ background: color }} />
              <span>{d.id}</span>
              <span className="muted">
                “{d.prompt}” {d.score.toFixed(2)}
              </span>
              <span className="own">{kind === "object" ? ownerText(d) : kind}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
