import { useActions, useSlice } from "./context.tsx";
import { TOOLS } from "./stage/tools.ts";

export function Toolbar() {
  const a = useActions();
  const tool = useSlice("layers", (s) => s.tool);
  const h = useSlice("objects", (s) => s.history);
  return (
    <nav className="toolbar" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          type="button"
          key={t.id}
          className={tool === t.id ? "on" : ""}
          aria-pressed={tool === t.id}
          aria-label={`${t.help.label} (${t.key})`}
          title={`${t.help.label} (${t.key}): ${t.help.tip}${t.help.more ? `\n\n${t.help.more}` : ""}`}
          data-tool={t.id}
          onClick={() => a.setTool(t.id)}
        >
          <span className="ico" aria-hidden="true">
            {t.icon}
          </span>
          <span className="tl">{t.help.label}</span>
        </button>
      ))}
      <hr />
      <button
        type="button"
        aria-label="Undo (Ctrl+Z)"
        title={h?.undo ? `Undo #${h.undo.seq} ${h.undo.op} (Ctrl+Z)` : "Nothing to undo"}
        disabled={!h?.undo}
        onClick={() => void a.undo()}
      >
        <span className="ico" aria-hidden="true">
          ↶
        </span>
        <span className="tl">Undo</span>
      </button>
      <button
        type="button"
        aria-label="Redo (Ctrl+Shift+Z)"
        title={h?.redo ? `Redo #${h.redo.seq} ${h.redo.op}` : "Nothing to redo"}
        disabled={!h?.redo}
        onClick={() => void a.redo()}
      >
        <span className="ico" aria-hidden="true">
          ↷
        </span>
        <span className="tl">Redo</span>
      </button>
    </nav>
  );
}
