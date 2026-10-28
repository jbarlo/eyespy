/**
 * Notices, the busy queue, confirmations, and `run` for engine calls.
 */
import type { Result, ResultAsync } from "neverthrow";
import { MAX_NOTICES } from "../notices.ts";
import type { EngineSession } from "../ports.ts";
import { sessionOf } from "./context.ts";
import type { Ctx, Failure } from "./context.ts";

type BusyHandle = {
  readonly progress: (done: number, total: number) => void;
  /** True once the user cancelled (or the entry is gone). */
  readonly cancelled: () => boolean;
  readonly end: () => void;
};

const NOTE_MS = 12_000;

export function createRunner(ctx: Ctx, refresh: () => Promise<void>) {
  const { notices } = ctx.stores;
  const nextId = () => notices.getState().seq + 1;

  const dismiss = (id: number) => notices.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));

  /** An error (or, with info, a note that goes away by itself) in the notices list. */
  function notify(text: string, info = false) {
    if (!info) console.warn("eyespy:", text);
    const id = nextId();
    notices.setState((s) => ({ seq: id, notices: [...s.notices.slice(-(MAX_NOTICES - 1)), { id, text, info }] }));
    if (info) ctx.deps.clock.after(NOTE_MS, () => dismiss(id));
  }

  /** A failure as a notice. It drops "disposed" failures, from a session closed mid-call that nobody is looking at. */
  const report = (e: Failure) => {
    if (e.kind !== "disposed") notify(e.message);
  };

  function begin(label: string, o: { cancellable?: boolean } = {}): BusyHandle {
    const id = nextId();
    notices.setState((s) => ({
      seq: id,
      busy: [...s.busy, { id, label, cancellable: o.cancellable ?? false, cancelled: false }],
    }));
    return {
      progress: (done, total) =>
        notices.setState((s) => ({ busy: s.busy.map((t) => (t.id === id ? { ...t, done, total } : t)) })),
      cancelled: () => notices.getState().busy.find((t) => t.id === id)?.cancelled ?? true,
      end: () => notices.setState((s) => ({ busy: s.busy.filter((t) => t.id !== id) })),
    };
  }

  const cancel = (id: number) =>
    notices.setState((s) => ({ busy: s.busy.map((t) => (t.id === id ? { ...t, cancelled: true } : t)) }));

  /** A yes/no question in the confirm dialog; a question still open is answered "no" first. */
  function ask(message: string, ok = "OK"): Promise<boolean> {
    notices.getState().confirm?.answer(false);
    return new Promise((resolve) => {
      const answer = (v: boolean) => {
        if (notices.getState().confirm?.answer === answer) notices.setState({ confirm: null });
        resolve(v);
      };
      notices.setState({ confirm: { message, ok, answer } });
    });
  }

  /**
   * Runs an engine action with a busy entry, shows an Err as a notice, and refreshes data afterwards unless `refresh`
   * is false. It shows no notice when `quiet` says the UI already shows the failure some other way. Resolves to the
   * value, or undefined when there is no session or the action failed.
   */
  async function run<T, E extends Failure>(
    label: string,
    fn: (s: EngineSession) => ResultAsync<T, E> | Promise<Result<T, E>>,
    o: { refresh?: boolean; quiet?: () => boolean } = {},
  ): Promise<T | undefined> {
    const s = sessionOf(ctx);
    if (!s) return undefined;
    const task = begin(label);
    const r = await fn(s);
    if (r.isErr() && !o.quiet?.()) report(r.error);
    if (o.refresh !== false) await refresh();
    task.end();
    return r.isOk() ? r.value : undefined;
  }

  return { notify, dismiss, report, begin, cancel, ask, run };
}

export type Runner = ReturnType<typeof createRunner>;
