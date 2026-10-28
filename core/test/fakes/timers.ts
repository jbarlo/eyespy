/** Nothing fires until `advance`, which also moves the FakeClock (the engine's idle check reads the clock). */
import type { Timers } from "../../src/ports/index.ts";
import type { FakeClock } from "./clock.ts";

type Timer = { readonly at: number; readonly every: number | null; readonly fn: () => void };

export class FakeTimers implements Timers {
  now = 0;
  /** Delays passed to `after`, in call order. */
  readonly afters: number[] = [];
  private nextId = 0;
  private readonly due = new Map<number, Timer>();

  constructor(private readonly clock?: FakeClock) {}

  after(ms: number, fn: () => void): () => void {
    this.afters.push(ms);
    return this.add({ at: this.now + ms, every: null, fn });
  }
  every(ms: number, fn: () => void): () => void {
    return this.add({ at: this.now + ms, every: ms, fn });
  }
  get pending(): number {
    return this.due.size;
  }

  /** Move time forward by `ms`, firing each timer as it falls due (an interval once per period). */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const [next] = [...this.due].filter(([, t]) => t.at <= end).sort(([ia, a], [ib, b]) => a.at - b.at || ia - ib);
      if (!next) break;
      const [id, t] = next;
      this.move(t.at);
      if (t.every === null) this.due.delete(id);
      else this.due.set(id, { ...t, at: t.at + t.every });
      t.fn();
    }
    this.move(end);
  }

  private add(t: Timer): () => void {
    const id = this.nextId++;
    this.due.set(id, t);
    return () => {
      this.due.delete(id);
    };
  }
  private move(to: number): void {
    this.clock?.advance(to - this.now);
    this.now = to;
  }
}
