/**
 * The single-owner actor and the Engine around the session. The actor is the only code that runs session work.
 * Requests enqueue a job and await its result. Jobs run one at a time, in submission order. When the queue is
 * empty, the actor encodes keyframes in the background one unit at a time, so a query waits at most for the unit in
 * progress. There is never a second runner, so there are no locks.
 *
 * After a `permanent` background error the loop moves on to the next unit. After any other background failure it
 * backs off and retries, starting at BACKOFF_MS and doubling up to MAX_BACKOFF_MS, and resets after a unit
 * succeeds. Queued requests still run at once, because submit wakes the loop. This file may mutate state.
 */
import type { Result } from "neverthrow";
import { err, errAsync, ResultAsync } from "neverthrow";
import type { Timers } from "../ports/index.ts";
import type { Ctx } from "./pure.ts";
import { parseOverrides } from "./pure.ts";
import type { CreateEngine, Engine, EngineHost, EngineOptions, Session, SessionError } from "./types.ts";

const BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const IDLE_CHECK_MS = 30_000;

type Job = { readonly run: () => Promise<void> };

/** Errors that retrying the same background unit can't fix, because perception has marked the frame failed. */
const permanent = (e: SessionError): boolean => e.kind === "no-keyframe" || e.kind === "missing-frame-file";

const describe = (e: unknown): string =>
  e instanceof Error ? (e.stack ?? e.message) : typeof e === "string" ? e : JSON.stringify(e);

class Actor {
  private readonly q: Job[] = [];
  private running = false;
  private stopped = false;
  private backoff = BACKOFF_MS;
  private cancelRetry: (() => void) | null = null;

  constructor(
    /** One unit of background work. Ok(false) means nothing is left. */
    private readonly background: () => ResultAsync<boolean, SessionError>,
    private readonly log: (...a: readonly unknown[]) => void,
    private readonly timers: Timers,
  ) {}

  /** Runs `fn` on the actor, or gives `shutting-down` once stopped. A rejection is a bug and rejects the result. */
  submit<T>(fn: () => PromiseLike<Result<T, SessionError>>): Promise<Result<T, SessionError>> {
    if (this.stopped) return Promise.resolve(err({ kind: "shutting-down" }));
    return new Promise((resolve, reject) => {
      this.q.push({ run: () => Promise.resolve().then(fn).then(resolve, reject) });
      this.kick();
    });
  }

  /** Wakes the loop, for example when there are new frames to encode. */
  kick(): void {
    if (!this.running && !this.stopped) void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  private retryLater(): void {
    this.cancelRetry?.();
    this.cancelRetry = this.timers.after(this.backoff, () => {
      this.cancelRetry = null;
      this.kick();
    });
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private async loop(): Promise<void> {
    this.running = true;
    while (!this.stopped) {
      const job = this.q.shift();
      if (job) {
        await job.run();
        continue;
      }
      const r = await this.background().then(
        (x) => x,
        (e: unknown) => {
          this.log("background:", describe(e));
          return null;
        },
      );
      if (r === null) {
        this.retryLater();
        break;
      }
      if (r.isErr()) {
        this.log("background:", describe(r.error));
        if (permanent(r.error)) continue;
        this.retryLater();
        break;
      }
      this.backoff = BACKOFF_MS;
      if (!r.value) break;
    }
    this.running = false;
    if (this.q.length && !this.stopped) this.kick();
  }
}

class EngineImpl implements Engine {
  private readonly actor: Actor;
  private lastRequest: number;
  private inflight = 0;
  private closed = false;
  private readonly cancelIdle: () => void;
  private readonly idleMinutes: number;

  constructor(
    private readonly session: Session,
    private readonly host: EngineHost,
    private readonly opts: EngineOptions,
  ) {
    this.actor = new Actor(
      () => session.background(),
      (...a) => host.logger.log(...a),
      host.timers,
    );
    this.lastRequest = host.clock.now();
    this.idleMinutes = opts.idleMinutes ?? session.config().idle_minutes;
    this.actor.kick();
    this.cancelIdle = host.timers.every(IDLE_CHECK_MS, () => this.checkIdle());
  }

  call<T>(
    cfg: Readonly<Record<string, number>> | undefined,
    fn: (s: Session, ctx: Ctx) => ResultAsync<T, SessionError>,
  ): ResultAsync<T, SessionError> {
    const parsed = parseOverrides(cfg);
    if (parsed.isErr()) return errAsync(parsed.error);
    const overrides = parsed.value;
    this.lastRequest = this.host.clock.now();
    this.inflight++;
    const done = this.actor
      // Build the effective config when the job runs, because an earlier queued `config` set may change it.
      .submit(() => fn(this.session, { cfg: { ...this.session.config(), ...overrides } }))
      .finally(() => {
        this.inflight--;
        this.lastRequest = this.host.clock.now();
        this.actor.kick(); // `add` may have created frames to encode
      });
    return new ResultAsync(done);
  }

  /** Exits once no request has arrived for idle_minutes and background encoding has finished. */
  private checkIdle(): void {
    const idle = this.host.clock.now() - this.lastRequest;
    if (idle > this.idleMinutes * 60_000 && !this.inflight && !this.session.pending().length) {
      this.host.logger.log(`idle for ${Math.round(idle / 60_000)} min, exiting`);
      this.shutdown();
    }
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdle();
    this.actor.stop();
    this.opts.onExit();
  }
}

export const createEngine: CreateEngine = (session, host, opts) => new EngineImpl(session, host, opts);
