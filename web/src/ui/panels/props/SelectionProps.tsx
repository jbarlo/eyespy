import { useState } from "react";
import type { FormEvent } from "react";
import { objColor, REJECTED } from "../../../state/index.ts";
import { Crop } from "../../common.tsx";
import { useActions, useDerived, useSlice } from "../../context.tsx";
import { HELP } from "../../help.ts";
import { Info } from "../../Info.tsx";
import { useOwnerText } from "../owner.ts";
import { SimilarList } from "./SimilarList.tsx";

function ObjectPicker({
  onPick,
  label = "Assign to object",
  button = "Assign",
}: {
  readonly onPick: (oid: string) => void;
  readonly label?: string;
  readonly button?: string;
}) {
  const a = useActions();
  const [v, setV] = useState("");
  const objs = useSlice("objects", (s) => s.objects);
  const resolve = (s: string) => {
    const t = s.trim();
    const id = t.split(/\s|·/)[0];
    return (
      objs.find((o) => o.id === id)?.id ??
      objs.find((o) => o.label.toLowerCase() === t.toLowerCase())?.id ??
      objs.find((o) => o.label.toLowerCase().includes(t.toLowerCase()))?.id
    );
  };
  const go = (e: FormEvent) => {
    e.preventDefault();
    const id = resolve(v);
    if (id) {
      onPick(id);
      setV("");
    } else a.notify(`no object matches “${v}”`);
  };
  return (
    <form className="inline" onSubmit={go}>
      <input
        aria-label={label}
        placeholder="type an object id or label"
        list="objects-list"
        value={v}
        onChange={(e) => setV(e.currentTarget.value)}
        disabled={!objs.length}
      />
      <button type="submit" disabled={!objs.length || !v.trim()}>
        {button}
      </button>
    </form>
  );
}

export function SelectionProps() {
  const a = useActions();
  const ids = useSlice("selection", (s) => s.ids);
  const m = useSlice("selection", (s) => s.matches);
  const sim = useSlice("selection", (s) => s.similar);
  const hasObjects = useSlice("objects", (s) => s.objects.length > 0);
  const newLabel = useSlice("triage", (s) => s.newLabel);
  const detById = useDerived((s) => s.detById());
  const ownerText = useOwnerText();
  const sel = ids.flatMap((id) => detById.get(id) ?? []);
  const only = sel.length === 1 ? sel[0] : undefined;
  const owners = [...new Set(sel.flatMap((d) => (d.object && d.object !== REJECTED ? [d.object] : [])))];
  return (
    <div className="props">
      <p>
        <strong>{sel.length}</strong> detection{sel.length === 1 ? "" : "s"} selected
        {sel.length > 0 && <> · {[...new Set(sel.map(ownerText))].join(", ")}</>}
      </p>
      <div className="crops">
        {sel.slice(0, 12).map((d) => (
          <figure key={d.id}>
            <button
              type="button"
              className="crop-btn"
              aria-label={`Go to ${d.id} on keyframe ${d.frame}`}
              onClick={() => a.goToDet(d.id, true)}
            >
              <Crop det={d} />
            </button>
            <figcaption>
              {d.id} · {d.score.toFixed(2)}
              <br />
              <span className="muted">“{d.prompt}”</span>
            </figcaption>
          </figure>
        ))}
        {sel.length > 12 && <p className="muted">+{sel.length - 12} more</p>}
      </div>
      <h4 title={HELP.whichObject.tip}>
        {HELP.whichObject.label} <Info help={HELP.whichObject} />
      </h4>
      {!hasObjects ? (
        <p className="muted">No objects yet: make the first one below.</p>
      ) : !m ? (
        <p className="muted">Ranking…</p>
      ) : !m.list.length ? (
        <p className="muted">No other objects to compare with.</p>
      ) : (
        <ol className="matches" aria-label="Suggested objects">
          {m.list.map((x, k) => (
            <li key={x.obj}>
              <button
                type="button"
                data-obj={x.obj}
                onClick={() => void a.assign(x.obj)}
                title={`closest sighting ${x.closest} (${x.closest_sim.toFixed(2)}), ${x.sightings} sightings`}
              >
                <i className="sw" style={{ background: objColor(x.obj) }} />
                Assign to {x.obj} · {x.label}
                <span className="muted"> {x.sim.toFixed(2)}</span>
                {k === 0 && <kbd>A</kbd>}
              </button>
            </li>
          ))}
        </ol>
      )}
      <ObjectPicker onPick={(o) => void a.assign(o)} />
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void a.newObject(newLabel);
        }}
      >
        <input
          aria-label="New object label"
          placeholder="label"
          value={newLabel}
          onChange={(e) => a.setNewLabel(e.currentTarget.value)}
        />
        <button type="submit" disabled={!sel.length} title={HELP.newObject.tip}>
          New object <kbd>N</kbd>
        </button>
      </form>
      <div className="actions">
        <button
          type="button"
          className="danger"
          disabled={!sel.length}
          title={HELP.reject.tip}
          onClick={() => void a.reject()}
        >
          Reject <kbd>X</kbd>
        </button>
        {owners.map((o) => (
          <button
            type="button"
            key={o}
            onClick={() =>
              void a.removeFrom(
                o,
                sel.filter((d) => d.object === o).map((d) => d.id),
              )
            }
          >
            Remove from {o}
          </button>
        ))}
        {only && (
          <button type="button" title={HELP.similar.tip} onClick={() => void a.runSimilar(only.id)}>
            {HELP.similar.label}
          </button>
        )}
        <button type="button" onClick={() => a.clearSelection()}>
          Clear <kbd>Esc</kbd>
        </button>
      </div>
      {sim && only && sim.id === only.id && <SimilarList title={`Looks like ${sim.id}`} list={sim.list} />}
    </div>
  );
}
