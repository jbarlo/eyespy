/**
 * Every action the UI and window.eyespyUI share, composed from the feature groups. Public actions never reject.
 * Expected failures arrive as Err values from the engine port, and the actions show them as notices. `installReactions`
 * sets up the state-level follow-ups outside component effects: rank objects for a new selection, and keep the
 * new-object label on the selection's prompt.
 */
import type { StoreApi } from "zustand/vanilla";
import type { Ctx } from "./context.ts";
import { createEditActions } from "./edit.ts";
import { createFindActions } from "./find.ts";
import { createLicenceActions } from "./licence.ts";
import { createRunner } from "./run.ts";
import { createSessionActions } from "./session.ts";
import { createSettingsActions } from "./settings.ts";
import { createTriageActions } from "./triage.ts";
import { createViewActions } from "./view.ts";

export type { Ctx, StateDeps } from "./context.ts";

export function createActions(ctx: Ctx) {
  const refresh = () => session.refresh();
  const runner = createRunner(ctx, refresh);
  const view = createViewActions(ctx, runner);
  const triage = createTriageActions(ctx, runner, view);
  const licence = createLicenceActions(ctx);
  const session = createSessionActions(ctx, runner, triage, licence);
  const edit = createEditActions(ctx, runner, view, triage);
  const find = createFindActions(ctx, runner, view, refresh);
  const settings = createSettingsActions(ctx, runner, session.loadClips);
  return {
    notify: runner.notify,
    dismiss: runner.dismiss,
    cancelTask: runner.cancel,
    ask: runner.ask,
    ...view,
    ...triage,
    ...session,
    ...edit,
    ...find,
    ...settings,
    ...licence,
  };
}

export type Actions = ReturnType<typeof createActions>;

/** Call `fn` when the picked values change (Object.is per element). */
function watch<S, const T extends readonly unknown[]>(store: StoreApi<S>, pick: (s: S) => T, fn: () => void) {
  return store.subscribe((s, prev) => {
    const a = pick(s),
      b = pick(prev);
    if (a.some((x, i) => !Object.is(x, b[i]))) fn();
  });
}

export function installReactions(ctx: Ctx, actions: Actions): () => void {
  const { selection, objects, triage } = ctx.stores;
  const offs = [
    // rank again after a new selection or an edit that cleared the ranking (runMatch skips a ranking it already has)
    watch(
      selection,
      (s) => [s.ids, s.matches],
      () => void actions.runMatch(),
    ),
    watch(
      objects,
      (s) => [s.objects],
      () => void actions.runMatch(),
    ),
    // the new-object label follows the selection's prompt (triage sets its own)
    watch(
      selection,
      (s) => [s.ids],
      () => {
        if (triage.getState().page) return;
        const first = selection.getState().ids[0];
        const d = first ? ctx.select.detById().get(first) : undefined;
        triage.setState({ newLabel: d?.prompt ?? "" });
      },
    ),
  ];
  return () => offs.forEach((off) => off());
}
