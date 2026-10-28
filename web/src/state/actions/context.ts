/** What every action group receives: the stores, the selectors, the asset caches and the outside world. */
import type { AssetCaches } from "../assets/index.ts";
import type { BrowserStorage, Clock, EnginePort, EngineSession, Host, Query } from "../ports.ts";
import type { Selectors } from "../selectors.ts";
import type { Stores } from "../stores.ts";

export type StateDeps = {
  readonly engine: EnginePort;
  readonly assets: AssetCaches;
  readonly storage: BrowserStorage;
  readonly query: Query;
  readonly clock: Clock;
  readonly host: Host;
  /** sha256 of the SAM License text this build ships. */
  readonly samLicense: string;
};

export type Ctx = {
  readonly stores: Stores;
  readonly select: Selectors;
  readonly assets: AssetCaches;
  readonly deps: StateDeps;
};

/** The minimal shape of every expected failure (EngineError, HostError, AssetError). The UI shows its message. */
export type Failure = { readonly kind: string; readonly message: string };

/** A thrown value from a host promise, as a Failure. */
export const failure = (e: unknown): Failure => ({ kind: "host", message: e instanceof Error ? e.message : String(e) });

export const sessionOf = (ctx: Ctx): EngineSession | null => ctx.stores.engine.getState().session;
