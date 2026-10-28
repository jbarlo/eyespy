/**
 * The web app's state: zustand vanilla stores built from ports, with no module-level state and no React (components
 * reach it through hooks).
 */
import { createActions, installReactions } from "./actions/index.ts";
import type { Actions, StateDeps } from "./actions/index.ts";
import type { AssetCaches } from "./assets/index.ts";
import { createSelectors } from "./selectors.ts";
import type { Selectors } from "./selectors.ts";
import { createStoreSet } from "./stores.ts";
import type { Stores } from "./stores.ts";

export type App = {
  readonly stores: Stores;
  readonly select: Selectors;
  readonly actions: Actions;
  readonly assets: AssetCaches;
  /** Stop the reactions and close the session. */
  readonly dispose: () => void;
};

export function createStores(deps: StateDeps): App {
  const stores = createStoreSet(deps.storage.prefs, deps.query);
  const select = createSelectors(stores);
  const ctx = { stores, select, assets: deps.assets, deps };
  const actions = createActions(ctx);
  const stopReactions = installReactions(ctx, actions);
  return {
    stores,
    select,
    actions,
    assets: deps.assets,
    dispose: () => {
      stopReactions();
      actions.closeSession();
    },
  };
}

export type { StateDeps } from "./actions/index.ts";
export type { Imaging, Sprites } from "./assets/index.ts";
export { browserImaging, createAssetCaches } from "./assets/index.ts";
export type { Selectors } from "./selectors.ts";
export { computeVisible, refKey } from "./selectors.ts";
export type { StoreStates } from "./stores.ts";
export type * from "./ports.ts";
export type * from "./types.ts";
export { currentTask } from "./notices.ts";
export type { Preferences } from "./settings.ts";
export { FEATURE_CACHE_CHOICES, FEATURE_DISK_CHOICES } from "./settings.ts";
export type { SessionRow, StorageSummary } from "./storage.ts";
export { clipsStorage } from "./storage.ts";
export type { StageHandle, StageStats } from "./stage.ts";
export { objColor, REJECT_COLOR, REJECTED, TODO_COLOR } from "./objects.ts";
