import type { LayerId } from "../../state/index.ts";
import { Panel, useNativeInput } from "../common.tsx";
import { useActions, useSlice } from "../context.tsx";
import { LAYER_HELP, settingHelp } from "../help.ts";
import { Info } from "../Info.tsx";

const LAYERS: readonly LayerId[] = ["objects", "todo", "rejects", "semantic", "gaps"];
const THRESHOLD = settingHelp("threshold");

export function LayersPanel() {
  const a = useActions();
  const L = useSlice("layers", (s) => s.layers);
  const threshold = useSlice("layers", (s) => s.threshold);
  const semPrompt = useSlice("layers", (s) => s.semPrompt);
  const current = useSlice("frames", (s) => s.current);
  const semHave = useSlice("detections", (s) =>
    s.runs.some((r) => r.frame === current && r.prompt === semPrompt && r.semantic),
  );
  const setThreshold = (v: string) => a.setThreshold(Number(v));
  const slider = useNativeInput(setThreshold);
  /** Commits on Enter or when focus leaves the field, like a native change event. */
  const commitHeatmap = (v: string) => {
    if (v.trim() && v.trim() !== semPrompt) void a.heatmap(v);
  };
  return (
    <Panel id="layers" title="Layers">
      {LAYERS.map((id) => (
        <label className="row" key={id} title={LAYER_HELP[id].tip}>
          <input
            type="checkbox"
            checked={L[id]}
            data-layer={id}
            onChange={(e) => a.setLayer(id, e.currentTarget.checked)}
          />
          {LAYER_HELP[id].label}
        </label>
      ))}
      {L.semantic && (
        <div className="sub">
          <label className="row">
            Heatmap prompt
            <input
              key={semPrompt}
              list="prompt-list"
              aria-label="Heatmap prompt"
              defaultValue={semPrompt}
              onBlur={(e) => commitHeatmap(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitHeatmap(e.currentTarget.value);
              }}
            />
          </label>
          {semPrompt && !semHave && (
            <button type="button" onClick={() => void a.heatmap(semPrompt)}>
              Compute heatmap for this frame
            </button>
          )}
        </div>
      )}
      <label className="row col" title={THRESHOLD.tip}>
        <span>
          {THRESHOLD.label} <output>{threshold.toFixed(2)}</output> <Info help={THRESHOLD} />
        </span>
        <input
          ref={slider}
          type="range"
          min={0.3}
          max={1}
          step={0.01}
          value={threshold}
          aria-label="Score threshold"
          onChange={(e) => setThreshold(e.currentTarget.value)}
        />
      </label>
    </Panel>
  );
}
