/** Triage: page through unassigned look-alike groups, one decision per group; the group is the selection. */
import { bestView } from "eyespy-core/detections/pure";
import { sessionOf } from "./context.ts";
import type { Ctx } from "./context.ts";
import type { Runner } from "./run.ts";
import type { ViewActions } from "./view.ts";

export function createTriageActions(ctx: Ctx, r: Runner, view: ViewActions) {
  const { triage, frames, layers } = ctx.stores;

  async function loadGroup(offset: number): Promise<void> {
    const s = sessionOf(ctx);
    if (!s) return;
    const res = await s.ops.todo({ groups: true, offset: Math.max(0, offset), threshold: layers.getState().threshold });
    if (sessionOf(ctx) !== s) return;
    if (res.isErr()) return r.report(res.error);
    const v = res.value;
    const groups = "groups" in v ? v.groups : [];
    const total = "groups_total" in v ? v.groups_total : 0;
    // the page ran off the end because groups left the queue, so show the last one
    if (!groups.length && offset > 0 && total > 0) return loadGroup(total - 1);
    const group = groups[0] ?? null;
    triage.setState({
      page: {
        offset: Math.max(0, Math.min(offset, Math.max(0, total - 1))),
        total: v.total,
        groupsTotal: total,
        group,
      },
    });
    if (!group) return view.clearSelection();
    const best = bestView(group.ids.flatMap((id) => ctx.select.detById().get(id) ?? []));
    if (best) frames.setState({ current: best.frame });
    view.select(group.ids);
    triage.setState({ newLabel: best?.prompt ?? "" });
  }

  return {
    loadGroup,
    startTriage: () => loadGroup(0),
    stopTriage: () => {
      triage.setState({ page: null });
      view.clearSelection();
    },
    skipGroup: async (d = 1) => {
      const page = triage.getState().page;
      if (page) await loadGroup(page.offset + d);
    },
    setNewLabel: (newLabel: string) => triage.setState({ newLabel }),
    /** After an edit, keeps triage moving by reading the same page again (the group just left the queue). */
    afterEdit: () => {
      ctx.stores.selection.setState({ matches: null });
      const page = triage.getState().page;
      if (page) void loadGroup(page.offset);
    },
  };
}

export type TriageActions = ReturnType<typeof createTriageActions>;
