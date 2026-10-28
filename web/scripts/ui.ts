/**
 * End-to-end check of the app UI on the real GPU. Drives the built page like a user (clicks, keys, drags), asserts
 * state through window.eyespy (the router) and window.eyespyUI, and saves numbered screenshots plus captions.json for a
 * walkthrough.
 *   node --import tsx scripts/ui.ts <h264 clip> [--second <h264 clip>] [--hevc <clip>] [--cli-session <dir>] [--out dir]
 *     [--profile dir] [--prompt jar]
 * --second also tests the Videos panel: add a second clip, remove it, re-add it.
 * --hevc takes a clip this browser can't decode (HEVC on a Chromium without an HEVC decoder) to test the can't-decode
 *   dialog.
 * --cli-session takes a CLI session folder (with .eyespy/). The script tests "Open folder…" on a copy of it in OPFS,
 *   with showDirectoryPicker stubbed. Headless can't drive the native dialog, so it stays untested.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { unrle } from "eyespy-core/detections/pure";
import { driver, launch, must, pageMounts, scratch, serve } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    profile: { type: "string" },
    second: { type: "string" },
    hevc: { type: "string" },
    prompt: { type: "string" },
    "cli-session": { type: "string" },
  },
});
const [video] = positionals;
if (!video)
  throw new Error(
    "usage: ui.ts <h264 clip> [--second h264 clip] [--hevc clip] [--cli-session dir] [--out dir] [--profile dir]",
  );
const OUT = o.out ?? scratch("web-ui");
const PROMPT = o.prompt ?? "jar";
const CLI = o["cli-session"] ? path.resolve(o["cli-session"], ".eyespy") : null;
mkdirSync(OUT, { recursive: true });

const srv = await serve(pageMounts(CLI ? { "/cli": CLI } : {}));
const { page, close } = await launch({ userDataDir: o.profile });
await page.setViewportSize({ width: 1280, height: 800 });
// "Open folder…" gets an OPFS folder, which has the same FileSystemDirectoryHandle type showDirectoryPicker returns
const FOLDER = "folder-test";
// known settings even on a reused profile: the default detector, and features kept on disk with the default budget
await page.addInitScript(() => {
  if (sessionStorage.getItem("eyespy-test")) return;
  sessionStorage.setItem("eyespy-test", "1");
  localStorage.setItem("eyespy.persistFeatures", "1");
  localStorage.removeItem("eyespy.detector");
  localStorage.removeItem("eyespy.featureCacheMB");
  localStorage.removeItem("eyespy.featureDiskMB");
});
await page.addInitScript((name) => {
  (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
    async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
}, FOLDER);
const d = driver(page, OUT);
const { captions, snap, step, state, idle, api } = d;
const ui = <T>(f: () => T) => page.evaluate(f);
/** Scrolls a side panel to the top of the sidebar, for screenshots. */
const top = (id: string) =>
  page.evaluate((id) => document.getElementById(`panel-${id}`)?.scrollIntoView({ block: "start" }), id);

/** A pixel inside a detection's mask (the mask pixel nearest the box centre), as client coordinates. */
async function pointOn(id: string) {
  const d = await page.evaluate(async (id) => {
    const r = await window.eyespy!.data.dets({ frames: id.split(".")[0], mask: "rle" });
    return r.dets.find((x) => x.id === id);
  }, id);
  if (d?.mask?.format !== "rle") throw new Error(`no detection ${id} with an RLE mask`);
  const { w, h, counts } = d.mask;
  const m = unrle(counts, w * h);
  let best: [number, number] = [0, 0],
    bd = Infinity;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x]) {
        const dd = (x - w / 2) ** 2 + (y - h / 2) ** 2;
        if (dd < bd) [bd, best] = [dd, [x, y]];
      }
  const at: [number, number] = [d.box[0] + best[0] + 0.5, d.box[1] + best[1] + 0.5];
  return page.evaluate(([x, y]) => window.eyespyStage!.toClient(x, y), at);
}

const session = `ui-${Date.now()}`;
const base = `${srv.url}/?models=/models&runtime=/nm`;

step("open the app");
await page.goto(`${base}&session=${session}`);
await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 120_000 });
assert.equal((await state()).frames, 0);
await snap("open", "A fresh session: the engine starts in a worker on WebGPU; add a video to begin.");

step("add the video");
// a fresh browser profile downloads the models during this step (screenshot only if that happens)
let added = false;
const dlShot = page
  .waitForFunction(() => window.eyespyUI?.state().downloads.some((n) => n.endsWith(".onnx")), null, {
    timeout: 120_000,
    polling: 100,
  })
  .then(async () => {
    if (added) return;
    await page.waitForTimeout(300);
    await snap(
      "models",
      "First use only: the models download once (progress in the status bar), are checked against their sha256 and cached in the browser.",
    );
  })
  .catch(() => {});
await page.setInputFiles("#empty-video", video);
await page.waitForFunction(() => window.eyespyUI.state().frames > 0, null, { timeout: 600_000 });
await idle();
await Promise.race([dlShot, page.waitForTimeout(500)]);
await page.waitForFunction(() => window.eyespyUI.state().downloads.length === 0, null, { timeout: 600_000 });
added = true;
const nFrames = (await state()).frames;
step(`${nFrames} keyframes`);
await page.waitForTimeout(1500); // thumbnails
await snap(
  "video-added",
  `Keyframes picked from the clip (${nFrames}); the filmstrip and slider step through them, ← → too.`,
);

step(`find ${PROMPT}`);
await page.fill("#prompt-input", PROMPT);
await page.click("form.promptbar button[type=submit]");
await page.waitForFunction(() => window.eyespyUI.state().busy?.startsWith("Finding"), null, { timeout: 30_000 });
await page
  .waitForFunction(() => document.querySelector(".statusbar progress") !== null, null, { timeout: 120_000 })
  .catch(() => {});
await page.waitForTimeout(800);
await snap(
  "finding",
  "Find runs frame by frame from the one on screen outward; masks appear as each frame finishes, with progress and Cancel in the status bar.",
);
await idle();
const st = await api("status");
assert.ok(st.detections > 0, "find produced detections");
step(`${st.detections} detections`);
await page.waitForFunction(() => window.eyespyUI.state().visible.length > 0, null, { timeout: 30_000 });
await page.waitForTimeout(500);
await snap(
  "found",
  `“${PROMPT}” found: unassigned detections in amber, drawn from the engine's masks (data.dets RLE).`,
);

step("hover and click a detection");
let s = await state();
const todoIds = s.visible.filter((v) => v.kind === "todo").map((v) => v.id);
assert.ok(todoIds.length >= 2, "at least two unassigned regions on the frame");
const target = must(todoIds[0], "an unassigned region");
const pt = await pointOn(target);
await page.mouse.move(pt.x, pt.y);
await page.waitForSelector(".tip");
await snap("hover", "Hovering a region highlights it; the tooltip shows owner, id, prompt and score.");
await page.mouse.click(pt.x, pt.y);
await page.waitForTimeout(300);
s = await state();
assert.equal(s.selection.length, 1, "click selects one region");
const picked = s.selection[0];
step(`selected ${picked}`);
await page.waitForTimeout(600);
await top("properties");
await snap(
  "selected",
  "Click selects (shift-click adds, Esc clears). Properties shows the crop and what can be done with it.",
);

step("create an object");
await page.fill('input[aria-label="New object label"]', `${PROMPT} A`);
await page.click('form.inline button[type=submit]:has-text("New object")');
await idle();
let objs = (await api("data.objects")).objects;
assert.equal(objs.length, 1);
const first = must(objs[0], "the new object");
assert.ok(first.members.some((m) => m === picked));
const o1 = first.id;
await page.waitForTimeout(400);
await top("properties");
await snap(
  "object",
  `Created ${o1} “${PROMPT} A”: the region takes the object's colour and label; the filmstrip ticks where it appears.`,
);

step("reject with X");
s = await state();
const other = s.visible.find((v) => v.kind === "todo")!.id;
await ui(() => 0);
await page.evaluate((id) => window.eyespyUI.select([id]), other);
await page.keyboard.press("x");
await idle();
const rej = (await api("data.objects")).rejected;
assert.ok(
  rej.some((r) => r === other),
  "X rejected the selection",
);
step(`rejected ${other}`);

step("layers");
await page.check('input[data-layer="rejects"]');
await page.waitForTimeout(300);
s = await state();
assert.ok(
  s.visible.some((v) => v.kind === "reject"),
  "rejects layer shows rejects",
);
const before = s.visible.filter((v) => v.kind === "todo").length;
await page.locator('input[aria-label="Score threshold"]').evaluate((el: HTMLInputElement) => {
  el.value = "0.85";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(300);
s = await state();
const after = s.visible.filter((v) => v.kind === "todo").length;
assert.ok(after <= before, "a higher threshold shows no more regions");
assert.equal(s.threshold, 0.85);
step(`todo regions ${before} -> ${after} at 0.85`);
await top("layers");
await snap(
  "layers",
  `Layers: rejects shown (red, struck through); the threshold slider at 0.85 re-filters live (${before} → ${after} unassigned regions) without rerunning.`,
);
await page.locator('input[aria-label="Score threshold"]').evaluate((el: HTMLInputElement) => {
  el.value = "0.5";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.check('input[data-layer="gaps"]');
await page.waitForTimeout(400);
await snap("gaps", "Gaps layer: everything assigned or rejected is darkened, so what is left stands out.");
await page.uncheck('input[data-layer="gaps"]');
await page.uncheck('input[data-layer="rejects"]');

step("semantic heatmap");
await page.click('form.promptbar button:has-text("Heatmap")');
await idle();
await page.waitForTimeout(1200);
s = await state();
assert.ok(s.layers.semantic);
assert.ok(s.layers.todo && s.layers.objects, "mask layers stay on");
await page.waitForTimeout(300);
await snap(
  "heatmap",
  `Semantic heatmap over the masks (semi-transparent, so frame and masks still read): SAM 3's per-pixel map for “${PROMPT}” on this frame, red where it's strongest.`,
);
await page.uncheck('input[data-layer="semantic"]');

step("triage");
await page.click('button:has-text("Start triage")');
await page.waitForFunction(() => window.eyespyUI.state().triage !== null, null, { timeout: 60_000 });
await page.waitForTimeout(800);
s = await state();
assert.ok(s.triage && s.triage.ids.length > 0, "triage has a group");
assert.deepEqual([...s.selection].sort(), [...s.triage.ids].sort(), "the group is the selection");
const g1 = s.triage;
await top("triage");
await snap(
  "triage",
  `Triage: ${g1.groups} groups of look-alikes; each group is selected on the canvas with ranked object suggestions. Keys: A assign, N new, X reject, S skip.`,
);
await page.waitForFunction(() => window.eyespyUI.state().matches.length > 0, null, { timeout: 30_000 });
await page.keyboard.press("a"); // assign to the top match
await idle();
await page.waitForTimeout(500);
objs = (await api("data.objects")).objects;
const o1m: readonly string[] = must(
  objs.find((x) => x.id === o1),
  o1,
).members;
assert.ok(
  g1.ids.every((id) => o1m.includes(id)),
  "A assigned the group to the top match",
);
s = await state();
step(`assigned group of ${g1.ids.length} to ${o1}; next group ${s.triage?.ids.join(",")}`);
await page.keyboard.press("n"); // next group becomes a new object
await idle();
objs = (await api("data.objects")).objects;
assert.equal(objs.length, 2, "N made a second object");
const o2 = must(
  objs.find((x) => x.id !== o1),
  "the second object",
).id;
s = await state();
const offBefore = s.triage!.offset;
await page.keyboard.press("s");
await page.waitForFunction(
  (off) => (window.eyespyUI.state().triage?.offset ?? -1) > off || window.eyespyUI.state().triage?.ids.length === 0,
  offBefore,
  { timeout: 30_000 },
);
await page.waitForTimeout(500);
await top("triage");
await snap("triage-step", `After A (assigned to ${o1}), N (new ${o2}) and S (skip): the queue moves on by itself.`);
await page.click('#panel-triage button:has-text("Stop")');

step("region search");
await page.keyboard.press("b");
s = await state();
assert.equal(s.tool, "search");
const box = await page.locator(".stage canvas").boundingBox();
const [x0, y0] = [box!.x + box!.width * 0.3, box!.y + box!.height * 0.3];
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x0 + box!.width * 0.25, y0 + box!.height * 0.3, { steps: 8 });
await page.mouse.up();
await page.waitForSelector('form[aria-label="Region search"]');
await page.fill('input[aria-label="Region prompt"]', PROMPT);
const detsBefore = (await api("status")).detections;
await page.click('button:has-text("Search region")');
await idle();
await page.waitForTimeout(800);
const detsAfter = (await api("status")).detections;
step(`region search: detections ${detsBefore} -> ${detsAfter}`);
await top("properties");
await snap(
  "region-search",
  "Region search (B): drag a box; the crop is upscaled and searched by prompt (hits become detections) and by appearance. Crop-based, not a SAM box prompt.",
);
await page.keyboard.press("Escape");
await page.keyboard.press("v");

step("object panel and merge");
await page.click(`button.obj-row[data-obj="${o2}"]`);
await page.waitForTimeout(800);
s = await state();
assert.equal(s.selectedObj, o2);
await top("properties");
await snap(
  "object-panel",
  `Object ${o2}: rename, sightings gallery, suggestions, merge, delete; the filmstrip marks its keyframes.`,
);
await page.selectOption('select[aria-label="Merge this object into"]', o1);
await page.click('button:has-text("Merge")');
await page.waitForSelector("dialog[open]");
await snap("merge-confirm", `Merging ${o2} into ${o1} asks first (dragging one object onto another does the same).`);
await page.click("dialog[open] button.primary");
await idle();
objs = (await api("data.objects")).objects;
assert.equal(objs.length, 1, "merged");

step("history and undo");
await page.click("#panel-history > summary");
await page.keyboard.press("Control+z");
await idle();
objs = (await api("data.objects")).objects;
assert.equal(objs.length, 2, "undo brought the merged object back");
let h = await api("data.history");
assert.equal(h.ops.at(-1)?.op, "undo");
await page.waitForTimeout(400);
await top("history");
await snap("history", "History: the op log (ops.jsonl). Ctrl+Z undid the merge (struck through); Ctrl+Shift+Z redoes.");
await page.keyboard.press("Control+Shift+z");
await idle();
assert.equal((await api("data.objects")).objects.length, 1, "redo merged again");
await page.click("#panel-history > summary");

step("drag to merge, rename, delete + undo");
await page.keyboard.press("Control+z"); // two objects again
await idle();
await top("objects");
await page.dragAndDrop(`li:has(> button.obj-row[data-obj="${o2}"])`, `li:has(> button.obj-row[data-obj="${o1}"])`);
await page.waitForSelector("dialog[open]");
assert.match((await page.textContent("dialog[open]"))!, new RegExp(`Merge ${o2} .* into ${o1}`));
await page.click("dialog[open] button.primary");
await idle();
objs = (await api("data.objects")).objects;
assert.deepEqual(
  objs.map((x: { id: string }) => x.id),
  [o1],
  "dragging o2 onto o1 merged it",
);
await page.click(`button.obj-row[data-obj="${o1}"]`);
await page.fill('input[aria-label="Object label"]', `${PROMPT} (big)`);
await page.click('button:has-text("Rename")');
await idle();
assert.equal((await api("data.objects")).objects[0]?.label, `${PROMPT} (big)`);
await page.click('button:has-text("Delete object")');
await page.click("dialog[open] button.primary");
await idle();
assert.equal((await api("data.objects")).objects.length, 0, "deleted");
await page.keyboard.press("Control+z");
await idle();
objs = (await api("data.objects")).objects;
assert.equal(objs.length, 1, "undo restored the deleted object");
assert.equal(objs[0]?.label, `${PROMPT} (big)`);
await page.keyboard.press("Escape");

/** Goes to a keyframe showing at least n unassigned regions and returns their ids. */
async function frameWithTodo(n: number) {
  for (const f of await ui(() => window.eyespyUI.state().frameNumbers)) {
    await page.evaluate((f) => window.eyespyUI.setFrame(f), f);
    await page.waitForTimeout(150);
    const t = (await state()).visible.filter((v) => v.kind === "todo").map((v) => v.id);
    if (t.length >= n) return t;
  }
  throw new Error(`no keyframe with ${n} unassigned regions`);
}
const boxesOf = (ids: string[]) =>
  page.evaluate(async (ids) => {
    const first = ids[0];
    if (!first) throw new Error("boxesOf: no ids");
    const r = await window.eyespy!.data.dets({ frames: String(Number(first.split(".")[0])), mask: "none" });
    return Object.fromEntries(
      r.dets
        .filter((d: { id: string }) => ids.includes(d.id))
        .map((d: { id: string; box: readonly number[] }) => [d.id, d.box]),
    );
  }, ids) as Promise<Record<string, [number, number, number, number]>>;

// the engine never reuses object ids. o2 was merged away, and o1 deleted and restored, so the next object is o3.
step("new object id after merge/delete");
let todo = await frameWithTodo(1);
await page.evaluate((id) => window.eyespyUI.select([id]), must(todo[0], "an unassigned region"));
await page.fill('input[aria-label="New object label"]', `${PROMPT} C`);
await page.click('form.inline button[type=submit]:has-text("New object")');
await idle();
objs = (await api("data.objects")).objects;
assert.deepEqual(objs.map((x: { id: string }) => x.id).sort(), [o1, "o3"], "the new object is o3, not the freed o2");
assert.ok(await page.$('button.obj-row[data-obj="o3"]'));
step(`new object o3 (o2 not reused)`);

step("rect select (drag)");
todo = await frameWithTodo(2);
const bx = await boxesOf(todo);
const pair = todo.slice(0, 2);
const boxes = pair.map((i) => must(bx[i], `the box of ${i}`));
const r0 = [
  Math.min(...boxes.map((b) => b[0])) - 3,
  Math.min(...boxes.map((b) => b[1])) - 3,
  Math.max(...boxes.map((b) => b[2])) + 3,
  Math.max(...boxes.map((b) => b[3])) + 3,
] as const;
await page.keyboard.press("m");
assert.equal((await state()).tool, "rect");
const p0 = await page.evaluate(([x, y]) => window.eyespyStage!.toClient(x, y), [r0[0], r0[1]] as const);
const p1 = await page.evaluate(([x, y]) => window.eyespyStage!.toClient(x, y), [r0[2], r0[3]] as const);
await page.mouse.move(p0.x, p0.y);
await page.mouse.down();
await page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 5 });
await page.mouse.move(p1.x, p1.y, { steps: 5 });
await page.waitForTimeout(100);
await snap("rect-drag", "Rect select (M): dragging a box over the canvas.");
await page.mouse.up();
await page.waitForTimeout(300);
s = await state();
for (const id of pair) assert.ok(s.selection.includes(id), `rect selected ${id}`);
const selBoxes = await boxesOf(s.selection);
// the drag maps back to frame pixels with sub-pixel rounding, so allow 2 px
for (const id of s.selection) {
  const b = must(selBoxes[id], `the box of ${id}`);
  assert.ok(
    b[0] >= r0[0] - 2 && b[1] >= r0[1] - 2 && b[2] <= r0[2] + 2 && b[3] <= r0[3] + 2,
    `${id} lies inside the box`,
  );
}
step(`rect selected ${s.selection.join(", ")}`);
await top("properties");
await snap("rect-selected", `Rect select picked the ${s.selection.length} shown regions inside the box.`);
await page.keyboard.press("v");

step("find similar");
const simQuery = must(pair[0], "a rect-selected region");
await page.evaluate((id) => window.eyespyUI.select([id]), simQuery);
await page.click('button:has-text("Find similar")');
await page.waitForSelector(`#panel-properties h4:has-text("Looks like ${simQuery}")`, { timeout: 60_000 });
const nSim = await page.locator('#panel-properties h4:has-text("Looks like") + .crops figure').count();
assert.ok(nSim > 0, "similar detections listed");
await page.waitForTimeout(600);
await top("properties");
await snap(
  "similar",
  `Find similar: ${nSim} detections on other keyframes ranked by DINOv2 appearance similarity to ${simQuery}; click one to go there.`,
);

step("remove from object");
const o1members: readonly string[] = must(
  (await api("data.objects")).objects.find((x) => x.id === o1),
  o1,
).members;
const victim = must(o1members[0], `a member of ${o1}`);
await page.evaluate((id) => window.eyespyUI.setFrame(Number(id.split(".")[0])), victim);
await page.evaluate((id) => window.eyespyUI.select([id]), victim);
await page.click(`button:has-text("Remove from ${o1}")`);
await idle();
const after1 = (await api("data.objects")).objects.find((x) => x.id === o1);
assert.ok(!after1?.members.some((m) => m === victim), `${victim} left ${o1}`);
step(`removed ${victim} from ${o1}`);

step("console panel");
await page.click("#panel-console > summary");
await page.fill('#panel-console input[aria-label="Op"]', "obj.label");
await page.fill(
  '#panel-console textarea[aria-label="Input JSON"]',
  JSON.stringify({ obj: "o3", label: `${PROMPT} (console)` }),
);
await page.click('#panel-console button:has-text("Run")');
await idle();
await page.waitForSelector("#panel-console pre.console-out");
const out = JSON.parse((await page.textContent("#panel-console pre.console-out"))!);
assert.equal(out.id, "o3");
assert.equal(out.label, `${PROMPT} (console)`);
assert.equal((await api("data.objects")).objects.find((x) => x.id === "o3")?.label, `${PROMPT} (console)`);
await page.fill('#panel-console input[aria-label="Op"]', "obj.nope");
await page.click('#panel-console button:has-text("Run")');
await idle();
await page.waitForFunction(
  () => window.eyespyUI.state().errors.some((e) => /obj\.nope|no procedure|No "mutation"/i.test(e)),
  null,
  { timeout: 10_000 },
);
await top("console");
await snap(
  "console",
  "Console: any router op as JSON (here obj.label on o3); the reply shows below, errors (an unknown op) as a toast.",
);
await page.evaluate(() => {
  for (const b of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss error"]')) b.click();
});
await page.click("#panel-console > summary");

if (o.second) {
  step("videos panel: add, remove, re-add");
  await page.click("#panel-videos > summary");
  await page.waitForSelector("#panel-videos li.video");
  assert.equal(await page.locator("#panel-videos li.video").count(), 1);
  const nBefore = (await state()).frames;
  await page.setInputFiles("#videos-add", o.second);
  await page.waitForFunction((n) => window.eyespyUI.state().frames > n, nBefore, { timeout: 600_000 });
  await idle();
  await page.waitForFunction(() => (window.eyespyUI.state().clips?.length ?? 0) === 2, null, { timeout: 60_000 });
  const extra = (await state()).frameNumbers.filter((f) => f >= nBefore);
  assert.equal(extra[0], nBefore, "the new clip's keyframes follow the first's");
  await page.evaluate((f) => window.eyespyUI.setFrame(f), must(extra[0], "a keyframe of the new clip"));
  await page.evaluate(([p]) => window.eyespyUI.find(p, "frame"), [PROMPT] as const);
  await idle();
  const secondDets = (await api("data.dets", { frames: String(extra[0]), mask: "none" })).dets;
  step(`added second clip: keyframes ${extra.join(",")}, ${secondDets.length} detections on #${extra[0]}`);
  let o4: string | null = null;
  const secondDet = secondDets[0];
  if (secondDet) {
    o4 = (await api("obj.new", { label: "only in the second clip", ids: [secondDet.id] })).id;
    assert.equal(o4, "o4");
    await ui(() => window.eyespyUI.refresh());
    await page.waitForFunction(() => window.eyespyUI.state().clips?.[1]?.objects === 1, null, { timeout: 30_000 }); // the open panel follows edits
  }
  await top("videos");
  await page.waitForTimeout(500);
  await snap(
    "videos",
    `Videos panel: each clip with its keyframe range, capture date, detections, objects and size on disk; Add video and Remove.`,
  );
  const name = path.basename(o.second);
  await page.click(`#panel-videos button[aria-label="Remove ${name}"]`);
  await page.waitForSelector("dialog[open]");
  assert.match((await page.textContent("dialog[open]"))!, /can't be undone/);
  await snap(
    "video-remove-confirm",
    "Removing a video asks first, in the page: it can't be undone, and objects seen only in it go too.",
  );
  await page.click("dialog[open] button.primary");
  await idle();
  await page.waitForFunction(() => window.eyespyUI.state().clips?.length === 1, null, { timeout: 60_000 });
  s = await state();
  assert.equal(s.frames, nBefore, "its keyframes are gone");
  assert.deepEqual(
    s.frameNumbers,
    Array.from({ length: nBefore }, (_, k) => k),
    "the other clip's numbers are unchanged",
  );
  assert.ok(s.frame < nBefore, "the view moved off the removed keyframes");
  if (o4)
    assert.ok(
      !(await api("data.objects")).objects.some((x: { id: string }) => x.id === o4),
      "an object seen only in the removed clip is deleted",
    );
  h = await api("data.history");
  assert.equal(h.ops.at(-1)?.op, "clip_remove");
  assert.equal(h.undo, null, "removal is a barrier: nothing before it can be undone");
  assert.ok(await page.$eval('button[aria-label="Undo (Ctrl+Z)"]', (b) => (b as HTMLButtonElement).disabled));
  const st2 = await api("status");
  assert.equal(st2.keyframes, nBefore);
  await page.click("#panel-history > summary");
  await top("history");
  await page.waitForTimeout(300);
  await snap(
    "video-removed",
    "After removing it: the other clip keeps its keyframe numbers; the history shows the removal (no undo past it).",
  );
  await page.click("#panel-history > summary");
  // add it again. It comes back at the same numbers, without its old detections.
  await page.setInputFiles("#videos-add", o.second);
  await page.waitForFunction((n) => window.eyespyUI.state().frames > n, nBefore, { timeout: 600_000 });
  await idle();
  s = await state();
  assert.deepEqual(
    s.frameNumbers.filter((f) => f >= nBefore),
    extra,
    "re-added at its original keyframe numbers",
  );
  assert.ok(
    s.notes.some((n) => /removed earlier/.test(n)),
    "the page says it came back",
  );
  assert.equal(
    (await api("data.dets", { frames: String(extra[0]), mask: "none" })).dets.length,
    0,
    "without its old detections",
  );
  step(`re-added at ${extra.join(",")}`);
  await page.click("#panel-videos > summary");
}

step("settings");
await page.click('button[aria-label="Settings"]');
await page.waitForSelector("dialog[open] .usage");
assert.ok(
  !(await page.evaluate(() => document.activeElement?.matches("button.info"))),
  "Settings doesn't open with an info button focused",
);
await snap(
  "settings",
  "Settings: site storage, models cache, eviction protection, each browser session's image features vs the rest (drop per session or all), keep features on disk, disk budget per session (default 4 GB, with this session's use against it), in-memory cache size, detector precision, session settings; each with an info button.",
);
let feat = await api("features");
assert.ok(feat.stored > 0, "features were saved");
assert.equal(feat.diskMB, 4096, "the engine started with the default 4 GB disk budget");
assert.equal(await page.inputValue('select[aria-label="Disk budget per session"]'), "4096");
// a new budget applies to the open session without a reopen
await page.selectOption('select[aria-label="Disk budget per session"]', "1024");
await idle();
assert.equal((await api("features")).diskMB, 1024, "budget applied to the open engine");
await page.selectOption('select[aria-label="Disk budget per session"]', "4096");
await idle();
assert.equal((await api("features")).diskMB, 4096);
await page.click('dialog[open] button:has-text("Drop features of every session")');
await page.waitForSelector('dialog[aria-label="Confirm"][open]');
await page.click('dialog[aria-label="Confirm"][open] button.primary');
await page.waitForSelector('dialog[aria-label="Settings"] [role="status"]:has-text("Dropped")', { timeout: 60_000 });
feat = await api("features");
assert.equal(feat.stored, 0, "Drop features of every session deleted them");
step(`cleared stored features (${feat.keyframes} keyframes, ${feat.inMemory} still in RAM)`);
await page.waitForTimeout(500);
await snap(
  "settings-cleared",
  "Settings after Drop features of every session: the session's stored image features are gone (frames in RAM stay usable).",
);
await page.uncheck('input[aria-label="Keep image features on disk"]');
await idle();
assert.equal((await api("features")).persist, false);
await page.click('dialog[open] button:has-text("Close")');
// reopen with features not saved. The engine re-encodes every keyframe into RAM only, and writes nothing.
step("reopen with features off");
const logsBefore = await ui(() => window.eyespyEvents.length);
await page.click(".menu > summary");
await page.click(`.menu-item[data-session="${session}"]`);
await page.waitForFunction(
  () => window.eyespyUI.state().engine === "ready" && window.eyespyUI.state().frames > 0,
  null,
  { timeout: 120_000 },
);
assert.equal((await api("features")).persist, false, "the engine started with persistFeatures off");
const enc0 = (await api("status")).encoded;
const kf = (await api("status")).keyframes;
assert.ok(enc0 < kf, `features re-encoded after reopen (encoded ${enc0}/${kf} right after)`);
for (let k = 0; ; k++) {
  const st3 = await api("status");
  if (st3.encoded >= st3.keyframes) break;
  if (k > 300) throw new Error(`re-encode stuck at ${st3.encoded}/${st3.keyframes}`);
  await page.waitForTimeout(2000);
}
const encLogs = await ui(
  () =>
    (window.eyespyEvents as { kind: string; text?: string }[]).filter(
      (e) => e.kind === "log" && /^encoded frame/.test(e.text ?? ""),
    ).length,
);
const encodedNow = await page.evaluate(
  (n) =>
    (window.eyespyEvents as { kind: string; text?: string }[])
      .slice(n)
      .filter((e) => e.kind === "log" && /^encoded frame/.test(e.text ?? "")).length,
  logsBefore,
);
assert.ok(encodedNow >= kf, `re-encoded every keyframe (${encodedNow} encodes logged since reopen, ${encLogs} in all)`);
assert.equal((await api("features")).stored, 0, "and saved none");
step(`re-encoded ${encodedNow} keyframes, none stored`);
await page.click('button[aria-label="Settings"]');
await page.waitForSelector("dialog[open] .usage");
await page.check('input[aria-label="Keep image features on disk"]');
await idle();
assert.equal((await api("features")).persist, true);
await page.click('dialog[open] button:has-text("Close")');

step("export manifest");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-manifest")]);
const mpath = path.join(OUT, "manifest.json");
await dl.saveAs(mpath);
const manifest = JSON.parse(readFileSync(mpath, "utf8"));
const nonEmpty = (await api("data.objects")).objects.filter((x) => x.members.length).length;
assert.equal(manifest.objects.length, nonEmpty);
assert.ok(manifest.meta.models);
assert.equal(manifest.meta.clips[0].first, 0);
step(
  `manifest: ${manifest.objects.length} objects, ${manifest.items.map((i: { label: string; count: number }) => `${i.count}× ${i.label}`).join(", ")}`,
);

step("session menu");
await page.click(".menu > summary");
await page.waitForSelector(`.menu-item[data-session="${session}"]`);
await snap(
  "sessions",
  "Session menu: new session from a video, add a video, open a CLI session folder, export, reopen browser sessions.",
);
await page.keyboard.press("Escape");
await page.click(".menu > summary");

const objsBeforeSwitch = (await api("data.objects")).objects.length;
if (o.hevc) {
  step("HEVC: can't-decode dialog");
  const name = path.basename(o.hevc);
  await page.click(".menu > summary");
  await page.setInputFiles('input[aria-label="New session from video"]', o.hevc);
  await page.waitForSelector("dialog[open] .unsupported-video", { timeout: 120_000 });
  const text = (await page.textContent("dialog[open]")) ?? "";
  assert.match(text, /Can't decode this video in this browser/);
  assert.ok(text.includes(`${name} is `), "names the file");
  assert.match(text, /H\.264 video in an MP4 file plays everywhere/);
  assert.match(text, /HandBrake.*Fast 1080p30/);
  assert.match(text, /Settings → Camera → Formats → “Most Compatible”/);
  assert.doesNotMatch(text, /ffmpeg/i, "no ffmpeg in the app's text");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Close",
    "the dialog starts on Close, not on the HandBrake link",
  );
  await snap(
    "unsupported",
    "A codec this browser can't decode (HEVC here): what plays everywhere (H.264 MP4) and how to convert it, HandBrake or the iPhone's Most Compatible setting.",
  );
  await page.click("dialog[open] button.primary");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 10_000 });
  await idle();
  assert.equal((await state()).frames, 0, "nothing was added");
  step(`refused: ${name}`);
  await page.evaluate(() => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss error"]')) b.click();
  });
  await page.click(".menu > summary");
  await page.click(`.menu-item[data-session="${session}"]`);
  await page.waitForFunction(
    () => window.eyespyUI.state().engine === "ready" && window.eyespyUI.state().frames > 0,
    null,
    { timeout: 120_000 },
  );
  await idle();
  assert.equal((await api("data.objects")).objects.length, objsBeforeSwitch, "reopened session kept its objects");
}

step("dark theme");
await page.emulateMedia({ colorScheme: "dark" });
const ids3 = await frameWithTodo(1).catch(() => [] as string[]);
const id3 = ids3[0];
if (id3) await page.evaluate((id) => window.eyespyUI.select([id]), id3);
await page.waitForTimeout(800);
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
assert.equal(bg, "rgb(21, 23, 26)", "dark background");
await top("properties");
await snap("dark", "Dark theme (prefers-color-scheme: dark): the same layout with the dark palette.");
await page.emulateMedia({ colorScheme: "light" });
await page.keyboard.press("Escape");

if (CLI) {
  step("open a CLI session folder");
  const files: string[] = [];
  const walk = (d: string, rel = "") => {
    for (const n of readdirSync(d)) {
      const r = rel ? `${rel}/${n}` : n;
      if (["feat", "out", "sock", "server.log"].includes(n) || n.endsWith(".tmp")) continue; // features are re-encoded
      if (statSync(path.join(d, n)).isDirectory()) walk(path.join(d, n), r);
      else files.push(r);
    }
  };
  walk(CLI);
  const cliMeta = JSON.parse(readFileSync(path.join(CLI, "session.json"), "utf8"));
  const cliObjs = Object.keys(JSON.parse(readFileSync(path.join(CLI, "objects.json"), "utf8"))).filter(
    (k) => k !== "x",
  );
  const cliDets = JSON.parse(readFileSync(path.join(CLI, "dets.json"), "utf8")).length;
  const cliFrames = cliMeta.clips
    .filter((c: { removed?: number }) => !c.removed)
    .reduce((a: number, c: { times: number[] }) => a + c.times.length, 0);
  // into OPFS folder-test/.eyespy, as a user's folder would hold it
  await page.evaluate(
    async ([name, files]) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name as string, { recursive: true }).catch(() => {});
      const base = await (
        await root.getDirectoryHandle(name, { create: true })
      ).getDirectoryHandle(".eyespy", { create: true });
      for (const f of files) {
        const parts = f.split("/");
        let d = base;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
        await w.write(await (await fetch(`/cli/${f}`)).arrayBuffer());
        await w.close();
      }
    },
    [FOLDER, files] as const,
  );
  step(`copied ${files.length} files of ${CLI}`);
  await page.click(".menu > summary");
  await page.click('.menu-item:has-text("Open folder")');
  await page.waitForFunction(
    (f) =>
      window.eyespyUI.state().session === f &&
      window.eyespyUI.state().engine === "ready" &&
      window.eyespyUI.state().frames > 0,
    FOLDER,
    { timeout: 120_000 },
  );
  await idle();
  s = await state();
  assert.equal(s.session, FOLDER);
  assert.equal(s.frames, cliFrames, "the folder's keyframes");
  const fo = (await api("data.objects")).objects;
  assert.deepEqual(fo.map((x) => x.id).sort(), [...cliObjs].sort(), "the folder's objects");
  assert.equal((await api("status")).detections, cliDets);
  assert.ok((await page.textContent(".menu > summary"))!.includes("(folder)"), "the session menu says it's a folder");
  // an edit lands in the folder's files (same layout as the CLI's)
  const target = fo.find((x) => x.members.length) ?? fo[0];
  if (target) {
    await page.click(`button.obj-row[data-obj="${target.id}"]`);
    await page.waitForSelector(`#panel-properties .props[data-obj="${target.id}"]`);
    await page.fill(
      `#panel-properties .props[data-obj="${target.id}"] input[aria-label="Object label"]`,
      `${target.label} (edited in the browser)`,
    );
    await page.click(`#panel-properties .props[data-obj="${target.id}"] button:has-text("Rename")`);
    await idle();
    const onDisk = await page.evaluate(async (name) => {
      const v = await (
        await (await navigator.storage.getDirectory()).getDirectoryHandle(name)
      ).getDirectoryHandle(".eyespy");
      const read = async (n: string) => (await (await v.getFileHandle(n)).getFile()).text();
      return {
        objects: JSON.parse(await read("objects.json")),
        ops: (await read("ops.jsonl")).trim().split("\n").at(-1),
      };
    }, FOLDER);
    assert.equal(onDisk.objects[target.id].label, `${target.label} (edited in the browser)`);
    assert.match(onDisk.ops!, /"op": "label"/);
    await page.waitForTimeout(800);
    await snap(
      "folder",
      `“Open folder…” on a copy of a CLI session (${cliFrames} keyframes, ${cliObjs.length} objects, ${cliDets} detections; features re-encoded): a rename writes the folder's objects.json and ops.jsonl.`,
    );
  }
  step(`folder session: ${s.frames} keyframes, ${fo.length} objects`);
}

step("phone layout");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
await snap("phone", "The same app at phone width: tools on top, canvas, then the panels.");
await page.setViewportSize({ width: 1280, height: 800 });

step("debug page");
await page.goto(`${base}&debug&session=${session}`);
await page.waitForFunction(() => window.eyespyReady !== undefined);
await page.evaluate(() => window.eyespyReady!.then(() => true));
assert.ok(await page.$("#status"));

await close();
srv.close();
d.finish();
console.log(`ok: ${captions.length} screenshots in ${OUT} (${d.elapsed().toFixed(0)} s)`);
