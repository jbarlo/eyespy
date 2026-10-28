import { useState } from "react";
import { objColor } from "../../state/index.ts";
import { Crop, Panel } from "../common.tsx";
import { useActions, useDerived, useSlice } from "../context.tsx";

export function ObjectsPanel() {
  const a = useActions();
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const objects = useSlice("objects", (s) => s.objects);
  const selectedObj = useSlice("selection", (s) => s.obj);
  const focus = useDerived((s) => s.focusObj());
  const detById = useDerived((s) => s.detById());
  const st = useSlice("engine", (s) => s.status);
  const f = filter.toLowerCase();
  const list = objects.filter((o) => !f || o.id.includes(f) || o.label.toLowerCase().includes(f));
  return (
    <Panel id="objects" title="Objects" badge={objects.length}>
      <input
        type="search"
        aria-label="Filter objects"
        placeholder="Filter"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {!objects.length && <p className="muted">No objects yet.</p>}
      <p className="hint muted">Drag an object onto another to merge it.</p>
      <ul className="list objects" aria-label="Objects">
        {list.map((o) => {
          const best = o.best ? detById.get(o.best) : undefined;
          return (
            <li
              key={o.id}
              draggable
              className={over === o.id && dragging !== o.id ? "drop" : ""}
              onDragStart={(e) => {
                setDragging(o.id);
                e.dataTransfer.setData("text/x-eyespy-obj", o.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (dragging && dragging !== o.id) {
                  e.preventDefault();
                  setOver(o.id);
                }
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                const from = e.dataTransfer.getData("text/x-eyespy-obj") || dragging;
                setOver(null);
                if (from && from !== o.id) void a.merge(o.id, from);
              }}
            >
              <button
                type="button"
                className={`obj-row${focus === o.id ? " on" : ""}`}
                aria-pressed={selectedObj === o.id}
                data-obj={o.id}
                onClick={() => a.focusObject(o.id)}
              >
                {best ? <Crop det={best} size={40} label={`${o.id} best view`} /> : <span className="crop ph" />}
                <i className="sw" style={{ background: objColor(o.id) }} />
                <span className="oid">{o.id}</span>
                <span className="olabel">{o.label}</span>
                <span className="muted">{o.sightings}×</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">{st ? `${st.assigned} assigned · ${st.rejected} rejected · ${st.todo} todo` : ""}</p>
    </Panel>
  );
}

export function ObjectsDatalist() {
  const objects = useSlice("objects", (s) => s.objects);
  return (
    <datalist id="objects-list">
      {objects.map((o) => (
        <option key={o.id} value={`${o.id} · ${o.label}`} />
      ))}
    </datalist>
  );
}
