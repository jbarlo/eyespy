import { useActions, useSlice } from "../context.tsx";
import { UNSUPPORTED_VIDEO as T } from "../help.ts";
import { Dialog } from "./Dialog.tsx";

export function UnsupportedVideoDialog() {
  const a = useActions();
  const v = useSlice("notices", (s) => s.unsupported);
  return (
    <Dialog open={!!v} label={T.title} onClose={a.closeUnsupported}>
      {v && (
        <div className="dialog unsupported-video">
          <h3>{T.title}</h3>
          <p>{T.why(v.file, v.codecName)}</p>
          <p className="muted small">
            {v.file}: {v.reason}
          </p>
          <div className="actions end">
            <button type="button" className="primary" data-initial-focus onClick={a.closeUnsupported}>
              Close
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ConfirmDialog() {
  const c = useSlice("notices", (s) => s.confirm);
  return (
    <Dialog open={!!c} label="Confirm" onClose={() => c?.answer(false)}>
      {c && (
        <div className="dialog">
          <p>{c.message}</p>
          <div className="actions end">
            <button type="button" onClick={() => c.answer(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => c.answer(true)}>
              {c.ok}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
