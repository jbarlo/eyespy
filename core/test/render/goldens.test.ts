/**
 * Checks createRenderer against its module snapshot (`EYESPY_UPDATE_GOLDENS=1` rewrites it), the reference snapshot
 * and the cv2 goldens. The thickness-3 outline is a radius-2 disc, which matches cv2.drawContours exactly, so
 * `outline_*_3` and the overlays that draw it differ from the reference snapshot.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { RGB } from "../../src/pixels/index.ts";
import type { Region } from "../../src/render/index.ts";
import { createRenderer } from "../../src/render/index.ts";
import { color, CROP_COLS, CROP_TILE, GRID_COLS, JET, outline } from "../../src/render/pure.ts";
import { json, type Known, noise, npz, parity, sha256 } from "../fixtures/numerics/lib.ts";
import { FakeCodec, fakeFrames, fno, unwrap } from "./fakes.ts";

const UPDATE = process.env.EYESPY_UPDATE_GOLDENS === "1";
const SNAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "render.json");
const reference = json<Record<string, unknown>>("render.json");
const snap: Record<string, unknown> = UPDATE ? {} : (JSON.parse(readFileSync(SNAP, "utf8")) as Record<string, unknown>);
after(() => {
  if (UPDATE) writeFileSync(SNAP, JSON.stringify(snap, null, 1) + "\n");
});

/** Keys allowed to differ from the reference snapshot (and required to). */
const CHANGED = new Set(["render.default", "render.labelled"]);

/** Must match the module snapshot; must match the reference unless the key (or `key.sub`) is in CHANGED. */
function golden(key: string, value: unknown, changed: (sub: string) => boolean = (sub) => CHANGED.has(sub)) {
  const v: unknown = JSON.parse(JSON.stringify(value));
  if (UPDATE) snap[key] = v;
  else {
    assert.ok(key in snap, `no golden ${key} in ${SNAP}; run with EYESPY_UPDATE_GOLDENS=1`);
    assert.deepEqual(v, snap[key], `golden ${key}`);
  }
  const old = reference[key];
  if (v !== null && typeof v === "object" && !Array.isArray(v) && old !== null && typeof old === "object") {
    const o = new Map(Object.entries(old));
    for (const [sub, x] of Object.entries(v)) {
      if (changed(`${key}.${sub}`))
        assert.notDeepEqual(x, o.get(sub), `${key}.${sub} should differ from the reference`);
      else assert.deepEqual(x, o.get(sub), `${key}.${sub} vs the reference`);
    }
  } else if (changed(key)) assert.notDeepEqual(v, old, `${key} should differ from the reference`);
  else assert.deepEqual(v, old, `${key} vs the reference`);
}

const pix = (img: RGB) => ({ w: img.w, h: img.h, sha256: sha256(img.data) });

type CvMeta = { outline: { name: string; W: number; H: number; box: [number, number, number, number] }[] };
const cvMeta = json<CvMeta>("render-cv2.json");
const cv = npz("render-cv2.npz");

test("color(): o1..o20 and other ids (pinned values)", () => {
  const ids = [...Array.from({ length: 20 }, (_, k) => `o${k + 1}`), "x", "3.12", "", "日本"];
  const cs = Object.fromEntries(ids.map((id) => [id, color(id)]));
  for (const c of Object.values(cs)) for (const v of c) assert.ok(v >= 60 && v < 255 && Number.isInteger(v));
  golden("color", cs);
});

const JET_KNOWN: Known = { n: 148, maxDiff: 1, why: "JET computed by formula, cv2's COLORMAP_JET is its own table" };
test("JET table: reference snapshot, and vs cv2.applyColorMap(COLORMAP_JET)", () => {
  assert.equal(JET.length, 768);
  golden("jet", { sha256: sha256(JET), first: [...JET.subarray(0, 12)], mid: [...JET.subarray(381, 390)] });
  parity(JET, cv("jet").data as Uint8Array, JET_KNOWN);
});

const T2 =
  "thickness 2: outline() stamps a 3x3 square on each boundary pixel, cv2 draws polyline segments (TS has extras)";
const OUTLINE_KNOWN: Record<string, Known> = {
  edge_2: { n: 3, maxDiff: 1, why: T2 },
  single_2: { n: 4, maxDiff: 1, why: T2 },
  two_2: { n: 4, maxDiff: 1, why: T2 },
  noise_2: { n: 5, maxDiff: 1, why: T2 },
};
const regions: Region[] = [];
for (const [k, c] of cvMeta.outline.entries()) {
  const mask = cv(`mask_${c.name}`).data as Uint8Array;
  regions.push({ id: `${k % 3}.${k + 1}`, frame: fno(k % 3), t: k * 0.4, score: 0.5 + k / 20, box: c.box, mask });
  for (const th of [2, 3])
    test(`outline ${c.name} thickness ${th}: snapshot, and vs cv2.drawContours`, () => {
      const pts = outline(mask, c.box, c.W, c.H, th);
      golden(`outline_${c.name}_${th}`, [...pts], () => th === 3);
      const drawn = new Uint8Array(c.W * c.H);
      for (let i = 0; i < pts.length; i += 2) drawn[pts[i + 1]! * c.W + pts[i]!] = 1;
      parity(drawn, cv(`drawn_${c.name}_${th}`).data as Uint8Array, OUTLINE_KNOWN[`${c.name}_${th}`]);
    });
}

test("outline: thickness 1 < 2 < 3 < 4 (each stamp strictly contains the previous)", () => {
  const c = cvMeta.outline[0]!;
  const mask = cv(`mask_${c.name}`).data as Uint8Array;
  const sets = [1, 2, 3, 4].map((th) => {
    const pts = outline(mask, c.box, c.W, c.H, th);
    return new Set(Array.from({ length: pts.length / 2 }, (_, k) => pts[2 * k + 1]! * c.W + pts[2 * k]!));
  });
  for (let k = 1; k < sets.length; k++) {
    assert.ok(sets[k]!.size > sets[k - 1]!.size, `thickness ${k + 1} wider than ${k}`);
    for (const p of sets[k - 1]!) assert.ok(sets[k]!.has(p));
  }
});

const W = 30,
  H = 24;
function renderer() {
  const text = new FakeCodec();
  return { text, r: createRenderer({ frames: fakeFrames(W, H), text }) };
}

test("overlay(): masks + outlines, scaled, labels and tag (outline fix shows here)", async () => {
  const { text, r } = renderer();
  const dets = regions.filter((d) => d.frame === 0);
  const id0 = dets[0]!.id;
  const a = await unwrap(r.overlay(fno(0), dets, { scale: 0.5 }));
  const b = await unwrap(
    r.overlay(fno(0), dets, {
      scale: 0.8,
      labels: new Map([[id0, "first"]]),
      colors: new Map([[id0, [10, 200, 30] as const]]),
    }),
  );
  const c = await unwrap(r.overlay(fno(1), [], { scale: 1 }));
  golden("render", { default: pix(a), labelled: pix(b), empty: pix(c), texts: text.texts });
});

test("tagged()", async () => {
  const { text, r } = renderer();
  golden("withTag", { img: pix(await unwrap(r.tagged(noise(5, 20, 10), fno(2), " p=0.50"))), texts: text.texts });
});

test("grid(): tiles resized to the first, cols per row, padded rows", () => {
  const { r } = renderer();
  const tiles = [noise(1, 8, 6), noise(2, 5, 9), noise(3, 8, 6), noise(4, 3, 3), noise(5, 16, 12)] as const;
  const g2 = pix(r.grid(tiles, 2));
  assert.deepEqual([g2.w, g2.h], [16, 18]);
  const g6 = pix(r.grid(tiles));
  assert.deepEqual([g6.w, g6.h], [8 * Math.min(GRID_COLS, tiles.length), 6]);
  golden("grid", { g2, g6 });
});

test("cropRegion(): padded crop with the outline (thickness 2, unchanged)", async () => {
  const { r } = renderer();
  const out: [string, ReturnType<typeof pix>][] = [];
  for (const d of regions) out.push([d.id, pix(await unwrap(r.cropRegion(d)))]);
  golden("cropRegion", Object.fromEntries(out));
});

test("cropSheet() / cropTiles(): letterboxed tiles, default and custom labels, limit", async () => {
  const { text, r } = renderer();
  const tiles = await unwrap(r.cropTiles(regions));
  for (const t of tiles) assert.deepEqual([t.w, t.h], [CROP_TILE, CROP_TILE]);
  const sheetImg = await unwrap(r.cropSheet(regions));
  assert.ok(sheetImg);
  const sheet = pix(sheetImg);
  assert.deepEqual([sheet.w, sheet.h], [CROP_TILE * Math.min(CROP_COLS, regions.length), CROP_TILE]);
  const limitedImg = await unwrap(r.cropSheet(regions, ["a", "b", "c"], 2));
  assert.ok(limitedImg);
  const limited = pix(limitedImg);
  assert.deepEqual([limited.w, limited.h], [2 * CROP_TILE, CROP_TILE]);
  assert.equal(await unwrap(r.cropSheet([])), null);
  golden("cropSheet", { tiles: tiles.map(pix), sheet, limited, texts: text.texts });
});

test("groupSheet(): one row per group, padded to CROP_COLS", async () => {
  const { text, r } = renderer();
  const img = await unwrap(
    r.groupSheet([
      { id: "g1", regions: regions.slice(0, 2) },
      { id: "g2", regions: regions.slice(2, 5) },
    ]),
  );
  assert.ok(img);
  const sheet = pix(img);
  assert.deepEqual([sheet.w, sheet.h], [CROP_COLS * CROP_TILE, 2 * CROP_TILE]);
  golden("groupSheet", { sheet, texts: text.texts });
  assert.equal(await unwrap(r.groupSheet([])), null);
});
