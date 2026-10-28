import { describeOp } from "eyespy-core/labelling/pure";
import { Panel } from "../common.tsx";
import { useActions, useSlice } from "../context.tsx";

export function HistoryPanel() {
  const a = useActions();
  const h = useSlice("objects", (s) => s.history);
  const ops = h ? h.ops.toReversed() : [];
  return (
    <Panel id="history" title="History" badge={h?.ops.length ?? ""} open={false}>
      <div className="actions">
        <button type="button" disabled={!h?.undo} onClick={() => void a.undo()}>
          Undo{h?.undo ? ` #${h.undo.seq} ${h.undo.op}` : ""}
        </button>
        <button type="button" disabled={!h?.redo} onClick={() => void a.redo()}>
          Redo{h?.redo ? ` #${h.redo.seq} ${h.redo.op}` : ""}
        </button>
      </div>
      {!ops.length && <p className="muted">No edits yet.</p>}
      <ol className="history" reversed aria-label="Edit log, newest first">
        {ops.slice(0, 200).map((e) => (
          <li key={e.seq} className={e.undone ? "undone" : ""} data-seq={e.seq}>
            <span className="seq">#{e.seq}</span> {describeOp(e)}
            {e.undone && <span className="muted"> (undone)</span>}
            {!e.undoable && e.op !== "undo" && e.op !== "redo" && (
              <span
                className="muted"
                title={
                  e.op === "clip_remove"
                    ? "Removing a video cannot be undone; nothing before it can be undone either"
                    : "This line has no undo data; nothing before it can be undone either"
                }
              >
                {" "}
                · no undo
              </span>
            )}
            {typeof e.ts === "number" && <span className="ts">{new Date(e.ts * 1000).toLocaleTimeString()}</span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
