/** The side panels, in order. */
import type { ReactNode } from "react";
import type { PanelId } from "../help.ts";
import { ConsolePanel } from "./Console.tsx";
import { FrameDetsPanel } from "./FrameDets.tsx";
import { HistoryPanel } from "./History.tsx";
import { LayersPanel } from "./Layers.tsx";
import { ObjectsPanel } from "./Objects.tsx";
import { PropertiesPanel } from "./Properties.tsx";
import { TriagePanel } from "./Triage.tsx";
import { VideosPanel } from "./Videos.tsx";

export { ObjectsDatalist } from "./Objects.tsx";

export const PANELS = [
  { id: "properties", Panel: PropertiesPanel },
  { id: "triage", Panel: TriagePanel },
  { id: "objects", Panel: ObjectsPanel },
  { id: "videos", Panel: VideosPanel },
  { id: "layers", Panel: LayersPanel },
  { id: "frame-dets", Panel: FrameDetsPanel },
  { id: "history", Panel: HistoryPanel },
  { id: "console", Panel: ConsolePanel },
] as const satisfies readonly { readonly id: PanelId; readonly Panel: () => ReactNode }[];
