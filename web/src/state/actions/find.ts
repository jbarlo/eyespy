/** Find over a frame spec, one frame per call (cancellable), the shown frame first and then outward; and heatmaps. */
import { ok } from "neverthrow";
import { parseSpec, specMessage, toSpec } from "../frames.ts";
import { sessionOf } from "./context.ts";
import type { Ctx } from "./context.ts";
import type { Runner } from "./run.ts";
import type { ViewActions } from "./view.ts";

export type FindResult = { readonly hits: number; readonly frames: number; readonly cancelled: boolean };

export function createFindActions(ctx: Ctx, r: Runner, view: ViewActions, refresh: () => Promise<void>) {
  const { frames, layers, detections } = ctx.stores;

  /** `scope`: "frame", "all" or a spec like "0-5,9". */
  async function find(p: string, scope: string): Promise<FindResult | undefined> {
    const s = sessionOf(ctx);
    const prompt = p.trim();
    if (!s || !prompt) return undefined;
    const { frames: fr, current: cur } = frames.getState();
    const scoped = scope === "frame" ? ok([cur]) : scope === "all" ? ok(fr.map((f) => f.frame)) : parseSpec(scope, fr);
    if (scoped.isErr()) {
      r.notify(specMessage(scoped.error));
      return undefined;
    }
    const list = scoped.value.toSorted((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
    // one call per keyframe, for progress and cancel. Each call protects the whole scope's stored features from
    // disk-budget eviction, so a sweep over more keyframes than the budget holds re-encodes only the overflow, as one
    // CLI find would
    const hold = list.length > 1 ? { hold: toSpec(list) } : {};
    const task = r.begin(`Finding “${prompt}”`, { cancellable: true });
    const step = async (k: number, hits: number): Promise<{ hits: number; cancelled: boolean }> => {
      const i = list[k];
      if (i === undefined || sessionOf(ctx) !== s) return { hits, cancelled: false };
      if (task.cancelled()) return { hits, cancelled: true };
      task.progress(k, list.length);
      const res = await s.ops.find({ prompt, frames: String(i), ...hold });
      if (res.isErr()) {
        r.report(res.error);
        return { hits, cancelled: false };
      }
      void view.loadMasks(i, true);
      if (k % 3 === 0 || k === list.length - 1) await refresh();
      return step(k + 1, hits + res.value.hits.length);
    };
    const out = await step(0, 0);
    await refresh();
    task.end();
    return { hits: out.hits, frames: list.length, cancelled: out.cancelled };
  }

  /** The semantic heatmap for the shown frame (computes the SAM 3 run when missing). */
  async function heatmap(p: string) {
    const prompt = p.trim();
    if (!prompt) return;
    layers.setState((l) => ({ semPrompt: prompt, layers: { ...l.layers, semantic: true } }));
    const cur = frames.getState().current;
    const have = detections.getState().runs.some((x) => x.frame === cur && x.prompt === prompt && x.semantic);
    if (!have) await r.run(`Heatmap “${prompt}”`, (s) => s.ops.semantic({ prompt, frames: String(cur) }));
    void view.loadMasks(cur, true);
  }

  return { find, heatmap };
}
