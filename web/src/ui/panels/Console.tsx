/** Console: any router op by name, JSON in and out. */
import { Result } from "neverthrow";
import { useState } from "react";
import type { OpPath } from "eyespy-core/api/pure";
import { OPS } from "eyespy-core/api/pure";
import { Panel } from "../common.tsx";
import { useActions } from "../context.tsx";

/** Router ops the console can't run: ones that take a picked file or stop the engine. */
const NOT_HERE: ReadonlySet<OpPath> = new Set(["add", "shutdown"]);
const CONSOLE_OPS = OPS.map((o) => o.path).filter((p) => !NOT_HERE.has(p));

const parseJson = Result.fromThrowable(
  (s: string): unknown => JSON.parse(s),
  (e) => (e instanceof Error ? e.message : String(e)),
);

/** RLE counts are long, so the console shows their length. */
const brief = (k: string, v: unknown) => (k === "counts" && Array.isArray(v) ? `[${v.length} runs]` : v);
const imageOf = (r: unknown) =>
  r && typeof r === "object" && "image" in r && typeof r.image === "string" ? r.image : undefined;

export function ConsolePanel() {
  const a = useActions();
  const [op, setOp] = useState("status");
  const [input, setInput] = useState("{}");
  const [out, setOut] = useState<{ json: string; image?: string } | null>(null);
  return (
    <Panel id="console" title="Console (any op)" open={false}>
      <form
        className="console"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = parseJson(input || "{}");
          if (body.isErr()) return a.notify(`input is not JSON: ${body.error}`);
          const r = await a.consoleCall(op, body.value);
          if (r !== undefined) setOut({ json: (JSON.stringify(r, brief, 1) ?? "").slice(0, 20000), image: imageOf(r) });
        }}
      >
        <input aria-label="Op" list="ops-list" value={op} onChange={(e) => setOp(e.currentTarget.value)} />
        <datalist id="ops-list">
          {CONSOLE_OPS.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <textarea aria-label="Input JSON" rows={3} value={input} onChange={(e) => setInput(e.currentTarget.value)} />
        <button type="submit">Run</button>
      </form>
      {out && (
        <>
          {out.image && <img className="console-img" src={out.image} alt="op result image" />}
          <pre className="console-out">{out.json}</pre>
        </>
      )}
    </Panel>
  );
}
