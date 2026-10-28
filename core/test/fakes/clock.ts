/** The core reads time only through Clock, so with this fake persisted bytes are reproducible on any machine. */
import type { Clock } from "../../src/ports/index.ts";

export class FakeClock implements Clock {
  /** Milliseconds since the epoch. */
  constructor(public ms = Date.UTC(2026, 0, 2, 3, 4, 5)) {}

  now(): number {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
}
