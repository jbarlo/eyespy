/** Labelling edits and the questions asked about the selection. Destructive edits confirm first. */
import { ResultAsync } from "neverthrow";
import type { Box } from "../types.ts";
import { failure, sessionOf } from "./context.ts";
import type { Ctx } from "./context.ts";
import type { Runner } from "./run.ts";
import type { TriageActions } from "./triage.ts";
import type { ViewActions } from "./view.ts";

export function createEditActions(ctx: Ctx, r: Runner, view: ViewActions, triage: TriageActions) {
  const { selection, frames, objects, layers } = ctx.stores;
  const ids = () => selection.getState().ids;
  const label = (oid: string) => ctx.select.objById().get(oid)?.label ?? "";

  async function newObject(text: string, list = ids()) {
    if (!list.length) return undefined;
    const res = await r.run("New object", (s) => s.ops.obj.new({ label: text.trim() || "item", ids: [...list] }));
    if (res) triage.afterEdit();
    return res;
  }
  async function assign(obj: string, list = ids()) {
    if (!list.length || !obj) return undefined;
    const res = await r.run(`Assign to ${obj}`, (s) => s.ops.obj.add({ obj, ids: [...list] }));
    if (res) triage.afterEdit();
    return res;
  }
  async function reject(list = ids()) {
    if (!list.length) return undefined;
    const res = await r.run("Reject", (s) => s.ops.reject({ ids: [...list] }));
    if (res) triage.afterEdit();
    return res;
  }
  const removeFrom = (obj: string, list = ids()) =>
    r.run(`Remove from ${obj}`, (s) => s.ops.obj.remove({ obj, ids: [...list] }));
  const rename = (obj: string, text: string) => r.run("Rename", (s) => s.ops.obj.label({ obj, label: text }));
  async function merge(into: string, from: string) {
    if (into === from) return undefined;
    if (!(await r.ask(`Merge ${from} “${label(from)}” into ${into} “${label(into)}”?`, "Merge"))) return undefined;
    const res = await r.run("Merge", (s) => s.ops.obj.merge({ into, from }));
    if (res) view.focusObject(into);
    return res;
  }
  async function deleteObject(obj: string) {
    if (!(await r.ask(`Delete ${obj} “${label(obj)}”? Its detections go back to the todo list.`, "Delete")))
      return undefined;
    const res = await r.run("Delete object", (s) => s.ops.obj.delete({ obj }));
    if (res) view.focusObject(null);
    return res;
  }

  /** Rank the objects for the current selection (once per selection; null when there's nothing to rank). */
  async function runMatch() {
    const list = ids();
    const key = list.join(",");
    const s = sessionOf(ctx);
    if (!s || !list.length || !objects.getState().objects.length) {
      if (selection.getState().matches) selection.setState({ matches: null });
      return;
    }
    if (selection.getState().matches?.key === key) return;
    const res = await s.ops.obj.match({ ids: [...list], k: 5 });
    if (sessionOf(ctx) !== s || ids().join(",") !== key) return;
    if (res.isErr()) return r.report(res.error);
    selection.setState({ matches: { key, current: res.value.current, list: res.value.matches } });
  }

  async function runSimilar(id: string) {
    const res = await r.run("Similar", (s) => s.ops.similar({ id, k: 12 }), { refresh: false });
    if (res) selection.setState({ similar: { id, list: res.matches } });
  }

  async function search(box: Box, prompt: string, similar: boolean) {
    const frame = frames.getState().current;
    const res = await r.run("Region search", (s) =>
      s.ops.search({ frame, box: [...box], prompt: prompt.trim() || null, similar, k: 8 }),
    );
    if (res) {
      selection.setState({ searchResult: res });
      void view.loadMasks(res.frame, true);
    }
    return res;
  }

  async function suggest(obj: string) {
    const res = await r.run(
      "Suggest",
      (s) => s.ops.obj.suggest({ obj, k: 8, threshold: layers.getState().threshold }),
      { refresh: false },
    );
    return res?.matches;
  }

  /** Any router op by name, JSON in and out (store references come back as object URLs). */
  const consoleCall = (op: string, input: unknown) =>
    r.run(op, (s) => ResultAsync.fromPromise(s.api.call(op, input), failure), {
      refresh: !op.startsWith("data."),
    });

  return {
    newObject,
    assign,
    reject,
    removeFrom,
    rename,
    merge,
    deleteObject,
    undo: () => r.run("Undo", (s) => s.ops.undo()),
    redo: () => r.run("Redo", (s) => s.ops.redo()),
    runMatch,
    runSimilar,
    search,
    suggest,
    consoleCall,
  };
}
