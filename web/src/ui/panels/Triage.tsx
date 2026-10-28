/** Triage: one look-alike group at a time; A / N / X / S decide it. */
import { Crop, Panel } from "../common.tsx";
import { useActions, useDerived, useSlice } from "../context.tsx";

export function TriagePanel() {
  const a = useActions();
  const t = useSlice("triage", (s) => s.page);
  const newLabel = useSlice("triage", (s) => s.newLabel);
  const top = useSlice("selection", (s) => s.matches?.list[0]);
  const todo = useSlice("engine", (s) => s.status?.todo);
  const hasDets = useSlice("detections", (s) => s.dets.length > 0);
  const current = useSlice("frames", (s) => s.current);
  const detById = useDerived((s) => s.detById());
  return (
    <Panel
      id="triage"
      title="Triage"
      badge={t ? `${Math.min(t.offset + 1, t.groupsTotal)}/${t.groupsTotal}` : todo ? `${todo} todo` : ""}
    >
      {!t ? (
        <>
          <p className="muted">
            Step through unassigned detections, grouped by look-alikes near in time, one decision per group.
          </p>
          <button type="button" disabled={!hasDets} onClick={() => void a.startTriage()}>
            Start triage
          </button>
        </>
      ) : !t.group ? (
        <>
          <p>Nothing left to triage above the threshold.</p>
          <button type="button" onClick={() => a.stopTriage()}>
            Done
          </button>
        </>
      ) : (
        <div className="triage" aria-live="polite">
          <p>
            Group <strong>{t.offset + 1}</strong> of {t.groupsTotal} · {t.group.ids.length} detection
            {t.group.ids.length === 1 ? "" : "s"} · frames {t.group.frames} · {t.total} unassigned
          </p>
          <div className="crops">
            {t.group.ids
              .flatMap((i) => detById.get(i) ?? [])
              .slice(0, 8)
              .map((d) => (
                <button
                  type="button"
                  key={d.id}
                  className={`crop-btn${d.frame === current ? " on" : ""}`}
                  aria-label={`Show ${d.id} on keyframe ${d.frame}`}
                  onClick={() => a.setFrame(d.frame)}
                >
                  <Crop det={d} size={64} />
                </button>
              ))}
          </div>
          <div className="actions keys">
            <button
              type="button"
              disabled={!top}
              onClick={() => top && void a.assign(top.obj)}
              title={top ? `Assign to ${top.obj} ${top.label}` : "No objects yet"}
            >
              <kbd>A</kbd> Assign{top ? ` to ${top.obj} · ${top.label}` : ""}
            </button>
            <button type="button" onClick={() => void a.newObject(newLabel)}>
              <kbd>N</kbd> New object “{newLabel}”
            </button>
            <button type="button" className="danger" onClick={() => void a.reject()}>
              <kbd>X</kbd> Reject
            </button>
            <button type="button" onClick={() => void a.skipGroup(1)}>
              <kbd>S</kbd> Skip
            </button>
            <button type="button" disabled={t.offset === 0} onClick={() => void a.skipGroup(-1)}>
              <kbd>⇧S</kbd> Back
            </button>
            <button type="button" onClick={() => a.stopTriage()}>
              Stop
            </button>
          </div>
          <p className="muted small">
            The group is the selection: Properties shows it and the other choices (assign elsewhere, edit the label
            first).
          </p>
        </div>
      )}
    </Panel>
  );
}
