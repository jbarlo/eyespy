/**
 * Default scene for session tests. The second "kitchen.mp4" in another folder is for ambiguous clip references.
 * Objects cover aliases, a look-alike pair across clips, a weak hit between score floor and threshold, an NMS
 * near-duplicate, and a prompt that answers on one clip only.
 */
import type { Scene } from "./scene.ts";

export const KITCHEN = "/videos/kitchen.mp4";
export const PANTRY = "/videos/pantry.mov";
export const EXTRA = "/videos/extra.mp4";
export const OTHER_KITCHEN = "/videos/old/kitchen.mp4";

export const WORLD: Scene = {
  clips: [
    {
      path: KITCHEN,
      key: "0a1b2c3d4e01",
      w: 160,
      h: 120,
      captured: "2026-01-01T10:00:00.000000Z",
      duration: 2,
      pan: 40,
      objects: [
        {
          name: "red jar",
          color: [200, 40, 40],
          prompts: { jar: 3, container: 2.5 },
          from: [20, 30, 60, 80],
          to: [40, 30, 80, 80],
        },
        {
          name: "orange jar",
          color: [210, 120, 40],
          prompts: { jar: 2, container: 2 },
          from: [100, 40, 130, 90],
          to: [92, 40, 122, 90],
        },
        { name: "blue lid", color: [40, 60, 200], prompts: { lid: 3 }, from: [24, 14, 56, 28] },
        { name: "smudge", color: [90, 96, 90], prompts: { jar: -0.2 }, from: [130, 96, 152, 116] },
      ],
    },
    {
      path: PANTRY,
      key: "0a1b2c3d4e02",
      w: 160,
      h: 120,
      captured: null,
      duration: 2,
      pan: 40,
      objects: [
        { name: "red jar", color: [200, 40, 40], prompts: { jar: 2.8, container: 2.4 }, from: [60, 40, 100, 100] },
        { name: "red jar ghost", color: [200, 40, 40], prompts: { jar: 1 }, from: [61, 40, 101, 100] },
        {
          name: "green box",
          color: [40, 180, 60],
          prompts: { box: 3, container: 1.5 },
          from: [110, 20, 150, 70],
          to: [100, 20, 140, 70],
        },
      ],
    },
    {
      path: EXTRA,
      key: "0a1b2c3d4e03",
      w: 160,
      h: 120,
      captured: "2026-01-01T12:00:00.000000Z",
      duration: 1,
      pan: 60,
      objects: [{ name: "white mug", color: [230, 230, 225], prompts: { mug: 3, jar: 0.5 }, from: [50, 50, 90, 100] }],
    },
    {
      path: OTHER_KITCHEN,
      key: "0a1b2c3d4e04",
      w: 160,
      h: 120,
      captured: null,
      duration: 0.4,
      pan: 10,
      objects: [{ name: "red jar", color: [200, 40, 40], prompts: { jar: 3 }, from: [20, 30, 60, 80] }],
    },
  ],
};
