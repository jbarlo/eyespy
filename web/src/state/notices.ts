/**
 * What the app tells and asks the user. Every running action has its own busy entry, so concurrent actions never
 * clear each other. App-scoped, so errors from a failed open stay visible.
 */
import { slice } from "./slice.ts";
import type { UnsupportedVideo } from "./types.ts";

type Notice = { readonly id: number; readonly text: string; readonly info: boolean };
export type BusyTask = {
  readonly id: number;
  readonly label: string;
  readonly done?: number;
  readonly total?: number;
  /** Set when the task can be cancelled; `cancelled` flips when the user does. */
  readonly cancellable: boolean;
  readonly cancelled: boolean;
};
type Ask = { readonly message: string; readonly ok: string; readonly answer: (ok: boolean) => void };

export type NoticesState = {
  readonly notices: readonly Notice[];
  readonly busy: readonly BusyTask[];
  readonly confirm: Ask | null;
  /** A video the engine refused because this browser can't decode it. The can't-decode dialog shows it until closed. */
  readonly unsupported: UnsupportedVideo | null;
  /** Id source for notices and busy tasks. */
  readonly seq: number;
};

export const MAX_NOTICES = 5;

export const createNoticesStore = () =>
  slice<NoticesState>(() => ({ notices: [], busy: [], confirm: null, unsupported: null, seq: 0 }));

/** The task the status bar shows, which is the most recently started one. */
export const currentTask = (s: NoticesState): BusyTask | null => s.busy.at(-1) ?? null;
