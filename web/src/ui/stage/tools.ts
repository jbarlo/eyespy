/** The canvas tools registry. */
import type { App, Box, Frame, ToolId } from "../../state/index.ts";
import { TOOL_HELP } from "../help.ts";
import type { Help } from "../help.ts";
import { clampBox } from "./view.ts";

type ToolCtx = { readonly app: App; readonly frame: Frame; readonly shift: boolean };

export type Tool = {
  readonly id: ToolId;
  readonly help: Help;
  /** The shortcut, as shown (pressed lowercase). */
  readonly key: string;
  readonly icon: string;
  readonly cursor: string;
  /** A drag on empty canvas: pan (a click without moving picks a region) or draw a box. */
  readonly drag: "pan" | "rect";
  /** A finished box, in frame pixels. */
  readonly onRect?: (box: Box, ctx: ToolCtx) => void;
};

const SELECT: Tool = {
  id: "select",
  help: TOOL_HELP.select,
  key: "V",
  icon: "↖",
  cursor: "default",
  drag: "pan",
};

export const TOOLS: readonly Tool[] = [
  SELECT,
  {
    id: "rect",
    help: TOOL_HELP.rect,
    key: "M",
    icon: "⬚",
    cursor: "crosshair",
    drag: "rect",
    onRect: (r, { app, shift }) => {
      const inside = app.select
        .visible()
        .filter(({ det: x }) => x.box[0] >= r[0] && x.box[1] >= r[1] && x.box[2] <= r[2] && x.box[3] <= r[3])
        .map((v) => v.det.id);
      app.actions.select(inside, shift);
    },
  },
  {
    id: "search",
    help: TOOL_HELP.search,
    key: "B",
    icon: "⌕",
    cursor: "crosshair",
    drag: "rect",
    onRect: (r, { app, frame }) => app.actions.setSearchRect(clampBox(r, frame.w, frame.h)),
  },
];

/** The tool with this id (the select tool for an unknown one). */
export const toolOf = (id: ToolId): Tool => TOOLS.find((t) => t.id === id) ?? SELECT;
