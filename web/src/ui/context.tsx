/** How components reach the state: from <StoresProvider> at the root, never from a module-level singleton. */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { invariant } from "eyespy-core/invariant";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";
import type { App, Selectors, StoreStates } from "../state/index.ts";

const AppContext = createContext<App | null>(null);

export function StoresProvider({ app, children }: { readonly app: App; readonly children: ReactNode }) {
  return <AppContext value={app}>{children}</AppContext>;
}

export function useApp(): App {
  const app = useContext(AppContext);
  invariant(app, "useApp outside <StoresProvider>");
  return app;
}

export const useActions = () => useApp().actions;

/** A value picked from one store; the picker must return something stable (a field, a primitive). */
export function useSlice<K extends keyof StoreStates, T>(key: K, pick: (s: StoreStates[K]) => T): T {
  const store: StoreApi<StoreStates[K]> = useApp().stores[key];
  return useStore(store, pick);
}

/** Derived data from the memoised selectors (stable references until their inputs change). */
export function useDerived<T>(fn: (sel: Selectors) => T): T {
  const { stores, select } = useApp();
  const subscribe = useCallback(
    (cb: () => void) => {
      const offs = Object.values(stores).map((s) => s.subscribe(cb));
      return () => offs.forEach((off) => off());
    },
    [stores],
  );
  return useSyncExternalStore(subscribe, () => fn(select));
}

/** Re-render when an asset cache changes (a thumbnail arrived, ...). */
export function useAssetVersion(cache: { subscribe: (fn: () => void) => () => void; version: () => number }) {
  return useSyncExternalStore(cache.subscribe, cache.version);
}
