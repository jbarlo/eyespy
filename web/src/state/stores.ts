/** The feature stores, created together. */
import { createDetectionsStore } from "./detections.ts";
import type { DetectionsState } from "./detections.ts";
import { createEngineStore } from "./engine.ts";
import type { EngineState } from "./engine.ts";
import { createFramesStore } from "./frames.ts";
import type { FramesState } from "./frames.ts";
import { createLayersStore } from "./layers.ts";
import type { LayersState } from "./layers.ts";
import { createLicenceStore } from "./licence.ts";
import type { LicenceState } from "./licence.ts";
import { createNoticesStore } from "./notices.ts";
import type { NoticesState } from "./notices.ts";
import { createObjectsStore } from "./objects.ts";
import type { ObjectsState } from "./objects.ts";
import type { Prefs, Query } from "./ports.ts";
import { createSelectionStore } from "./selection.ts";
import type { SelectionState } from "./selection.ts";
import { createSettingsStore } from "./settings.ts";
import type { SettingsState } from "./settings.ts";
import type { Slice } from "./slice.ts";
import { createStageStore } from "./stage.ts";
import type { StageState } from "./stage.ts";
import { createTriageStore } from "./triage.ts";
import type { TriageState } from "./triage.ts";

/** Each store's state type, by store name. */
export type StoreStates = {
  readonly engine: EngineState;
  readonly frames: FramesState;
  readonly detections: DetectionsState;
  readonly objects: ObjectsState;
  readonly selection: SelectionState;
  readonly layers: LayersState;
  readonly triage: TriageState;
  readonly notices: NoticesState;
  readonly settings: SettingsState;
  readonly stage: StageState;
  readonly licence: LicenceState;
};

export type Stores = { readonly [K in keyof StoreStates]: Slice<StoreStates[K]> };

export function createStoreSet(prefs: Prefs, query: Query): Stores {
  return {
    engine: createEngineStore(),
    frames: createFramesStore(),
    detections: createDetectionsStore(),
    objects: createObjectsStore(),
    selection: createSelectionStore(),
    layers: createLayersStore(),
    triage: createTriageStore(),
    notices: createNoticesStore(),
    settings: createSettingsStore(prefs, query),
    stage: createStageStore(),
    licence: createLicenceStore(),
  };
}

/**
 * Session data, which resets when another session opens. The other stores are app-scoped (view preferences, settings,
 * notices, the mounted Stage, the licence answer) and keep their state; each still has reset().
 */
export const SESSION_SCOPED = ["engine", "frames", "detections", "objects", "selection", "triage"] as const;
