import { useState } from "react";
import type { Det, Similar } from "../../../state/index.ts";
import { objColor } from "../../../state/index.ts";
import { Crop } from "../../common.tsx";
import { useActions, useDerived, useSlice } from "../../context.tsx";
import { HELP } from "../../help.ts";

/** One crop per frame: the best-scoring member, in frame order. */
const gallery = (members: readonly Det[]) =>
  [...Map.groupBy(members, (d) => d.frame).values()]
    .map((ds) => ds.reduce((x, y) => (y.score > x.score ? y : x)))
    .toSorted((x, y) => x.frame - y.frame);

export function ObjectProps({ oid }: { readonly oid: string }) {
  const a = useActions();
  const o = useDerived((s) => s.objById().get(oid));
  const objects = useSlice("objects", (s) => s.objects);
  const current = useSlice("frames", (s) => s.current);
  const detById = useDerived((s) => s.detById());
  const [label, setLabel] = useState(o?.label ?? "");
  const [into, setInto] = useState("");
  const [sugg, setSugg] = useState<readonly Similar[] | null>(null);
  if (!o) return <p className="muted">Object {oid} no longer exists.</p>;
  const shown = gallery(o.members.flatMap((m) => detById.get(m) ?? []));
  const others = objects.filter((x) => x.id !== oid);
  return (
    <div className="props" data-obj={oid}>
      <p>
        <i className="sw" style={{ background: objColor(oid) }} /> <strong>{oid}</strong> · {o.sightings} sightings ·{" "}
        {o.members.length} detections
        {o.first_t !== null && o.last_t !== null && (
          <>
            {" "}
            · {o.first_t.toFixed(1)}–{o.last_t.toFixed(1)} s
          </>
        )}
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim() && label !== o.label) void a.rename(oid, label.trim());
        }}
      >
        <input aria-label="Object label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        <button type="submit" disabled={!label.trim() || label === o.label}>
          Rename
        </button>
      </form>
      <h4>Sightings</h4>
      <div className="crops">
        {shown.slice(0, 24).map((d) => (
          <figure key={d.id}>
            <button
              type="button"
              className={`crop-btn${d.frame === current ? " on" : ""}`}
              aria-label={`Go to ${d.id} on keyframe ${d.frame}`}
              onClick={() => a.goToDet(d.id)}
            >
              <Crop det={d} size={72} />
            </button>
            <figcaption>#{d.frame}</figcaption>
          </figure>
        ))}
        {shown.length > 24 && <p className="muted">+{shown.length - 24} more frames</p>}
      </div>
      <div className="actions">
        <button
          type="button"
          title={HELP.suggest.tip}
          onClick={async () => {
            const list = await a.suggest(oid);
            if (list) setSugg(list);
          }}
        >
          {HELP.suggest.label}
        </button>
        <button type="button" className="danger" onClick={() => void a.deleteObject(oid)}>
          Delete object
        </button>
      </div>
      {sugg && (
        <>
          <h4>Unassigned lookalikes</h4>
          {!sugg.length && <p className="muted">None above the threshold.</p>}
          <ul className="list">
            {sugg.map((s) => (
              <li key={s.id} className="sugg">
                <button type="button" className="crop-btn" aria-label={`Go to ${s.id}`} onClick={() => a.goToDet(s.id)}>
                  <Crop det={s} size={56} />
                </button>
                <span>
                  {s.id} · sim {s.sim.toFixed(2)}
                </span>
                <button type="button" onClick={() => void a.assign(oid, [s.id])}>
                  Add to {oid}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {others.length > 0 && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (into) void a.merge(into, oid);
          }}
        >
          <select aria-label="Merge this object into" value={into} onChange={(e) => setInto(e.currentTarget.value)}>
            <option value="">Merge into…</option>
            {others.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} · {x.label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!into}>
            Merge
          </button>
        </form>
      )}
    </div>
  );
}
