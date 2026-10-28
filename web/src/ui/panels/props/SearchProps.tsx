/** Region search inside the dragged box. */
import { useState } from "react";
import type { Box } from "../../../state/index.ts";
import { Crop } from "../../common.tsx";
import { useActions, useApp, useSlice } from "../../context.tsx";
import { TOOL_HELP } from "../../help.ts";
import { Info } from "../../Info.tsx";
import { SimilarList } from "./SimilarList.tsx";

export function SearchProps({ rect: r }: { readonly rect: Box }) {
  const { stores } = useApp();
  const a = useActions();
  // the find prompt's value when the user drew the box, so prompt-bar keystrokes don't re-render this
  const [p, setP] = useState(() => stores.layers.getState().prompt);
  const [sim, setSim] = useState(true);
  const res = useSlice("selection", (s) => s.searchResult);
  const current = useSlice("frames", (s) => s.current);
  const same = res && res.frame === current && res.box.join() === r.join();
  return (
    <form
      className="props"
      aria-label="Region search"
      onSubmit={(e) => {
        e.preventDefault();
        void a.search(r, p, sim);
      }}
    >
      <p>
        <strong>Region search</strong> · {r[2] - r[0]}×{r[3] - r[1]} px on #{current}
      </p>
      <p className="note">
        {TOOL_HELP.search.tip} <Info help={TOOL_HELP.search} />
      </p>
      <label className="row col">
        Find in region (optional)
        <input
          aria-label="Region prompt"
          placeholder="e.g. label, lid, jar"
          value={p}
          onChange={(e) => setP(e.currentTarget.value)}
        />
      </label>
      <label className="row">
        <input type="checkbox" checked={sim} onChange={(e) => setSim(e.currentTarget.checked)} />
        Similar-looking detections (DINOv2)
      </label>
      <div className="actions">
        <button type="submit" disabled={!p.trim() && !sim}>
          Search region
        </button>
        <button type="button" onClick={() => a.clearSelection()}>
          Cancel
        </button>
      </div>
      {same && res && (
        <>
          {res.prompt && (
            <>
              <h4>
                “{res.prompt}” in region: {res.hits.length} hit{res.hits.length === 1 ? "" : "s"} (presence{" "}
                {res.presence})
              </h4>
              <div className="actions">
                {res.hits.length > 0 && (
                  <button type="button" onClick={() => a.select(res.hits.map((h) => h.id))}>
                    Select hits
                  </button>
                )}
              </div>
              <div className="crops">
                {res.hits.map((h) => (
                  <figure key={h.id}>
                    <button
                      type="button"
                      className="crop-btn"
                      aria-label={`Select ${h.id}`}
                      onClick={() => a.goToDet(h.id)}
                    >
                      <Crop det={h} size={72} />
                    </button>
                    <figcaption>
                      {h.id} · {h.score.toFixed(2)}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </>
          )}
          {res.similar.length > 0 && <SimilarList title="Looks like the region" list={res.similar} />}
        </>
      )}
    </form>
  );
}
