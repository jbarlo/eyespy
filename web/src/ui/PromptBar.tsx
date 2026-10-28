import { useState } from "react";
import type { FormEvent } from "react";
import { useActions, useSlice } from "./context.tsx";
import { HELP } from "./help.ts";
import { Info } from "./Info.tsx";

type Scope = "frame" | "all" | "range";
const asScope = (v: string): Scope => (v === "frame" || v === "range" ? v : "all");

export function PromptBar() {
  const a = useActions();
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState("");
  const prompt = useSlice("layers", (s) => s.prompt);
  const prompts = useSlice("engine", (s) => s.status?.prompts);
  const ready = useSlice("engine", (s) => s.session !== null);
  const hasFrames = useSlice("frames", (s) => s.frames.length > 0);
  const busy = useSlice("notices", (s) => s.busy.length > 0);
  const run = (e?: FormEvent) => {
    e?.preventDefault();
    void a.find(prompt, scope === "range" ? range : scope);
  };
  const disabled = !ready || !hasFrames || busy;
  return (
    <form className="promptbar" role="search" aria-label="Find" onSubmit={run}>
      <input
        id="prompt-input"
        type="search"
        placeholder="Find… e.g. jar   ( / )"
        aria-label="Prompt"
        list="prompt-list"
        value={prompt}
        onChange={(e) => a.setPrompt(e.currentTarget.value)}
      />
      <datalist id="prompt-list">
        {(prompts ?? []).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <select
        aria-label="Frames to search"
        title={HELP.findScope.tip}
        value={scope}
        onChange={(e) => setScope(asScope(e.currentTarget.value))}
      >
        <option value="all">All frames</option>
        <option value="frame">This frame</option>
        <option value="range">Frames…</option>
      </select>
      {scope === "range" && (
        <input
          className="range-spec"
          aria-label="Frame range, e.g. 0-5,9"
          placeholder="0-5,9"
          value={range}
          onChange={(e) => setRange(e.currentTarget.value)}
        />
      )}
      <button type="submit" disabled={disabled || !prompt.trim()} title={HELP.find.tip}>
        Find
      </button>
      <button
        type="button"
        disabled={disabled || !prompt.trim()}
        title={HELP.heatmap.tip}
        onClick={() => void a.heatmap(prompt)}
      >
        Heatmap
      </button>
      <Info help={HELP.find} />
    </form>
  );
}
