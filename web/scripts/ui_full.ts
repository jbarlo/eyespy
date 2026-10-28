/**
 * UI at full-session scale. Adds a whole H.264 MP4 clip, runs a find over every keyframe, then measures what only
 * shows at scale: draws and hover latency, keyframe stepping, filmstrip, triage, memory, OPFS use. Continues
 * <out>/captions.json.
 *   node --import tsx scripts/ui_full.ts <video> [--out dir] [--profile dir] [--prompt jar] [--disk-mb n]
 *     [--repeat prompt] [--drop]
 * --drop deletes the session from OPFS at the end, for repeated runs on one persistent profile.
 * --disk-mb is the disk budget per session (one of the Settings choices, or "unlimited").
 * --repeat runs a second find over every keyframe with this prompt, and counts the keyframes it re-encodes (with a
 *   budget below the clip, the overflow).
 *
 * The Stage counts real draws only, and skips a scheduled draw of an unchanged scene. A setter on stats.last records
 * every draw's time.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { StageStats } from "../src/state/index.ts";
import { driver, launch, pageMounts, scratch, serve } from "./harness.ts";

declare global {
  interface Window {
    /** The draw recorder ui_full installs, with the stats object it hooked and every draw's ms since. */
    drawLog?: { readonly stats: StageStats; readonly ms: number[] };
  }
}

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    profile: { type: "string" },
    prompt: { type: "string" },
    drop: { type: "boolean" },
    "disk-mb": { type: "string" },
    repeat: { type: "string" },
  },
});
const [video] = positionals;
if (!video) throw new Error("usage: ui_full.ts <video> [--out dir] [--profile dir] [--prompt jar]");
const OUT = o.out ?? scratch("web-ui-2");
const PROMPT = o.prompt ?? "jar";

const srv = await serve(pageMounts());
const { page, close } = await launch({ userDataDir: o.profile });
await page.setViewportSize({ width: 1280, height: 800 });
// features on disk with the default budget or --disk-mb, whatever the profile chose before
await page.addInitScript((diskMB) => {
  localStorage.setItem("eyespy.persistFeatures", "1");
  if (diskMB) localStorage.setItem("eyespy.featureDiskMB", diskMB);
  else localStorage.removeItem("eyespy.featureDiskMB");
}, o["disk-mb"] ?? null);
const d = driver(page, OUT, { resume: true });
const { snap, step, state, api } = d;
const idle = () => d.idle(3_600_000, 500);

/** Hooks the mounted Stage's stats so every real draw's time goes into window.drawLog.ms. */
const recordDraws = () =>
  page.evaluate(() => {
    const stats = window.eyespyStage!.stats;
    const ms: number[] = [];
    let last = stats.last;
    Object.defineProperty(stats, "last", {
      configurable: true,
      enumerable: true,
      get: () => last,
      set: (v: number) => {
        last = v;
        ms.push(v);
      },
    });
    window.drawLog = { stats, ms };
  });
/** Draws so far and how many draw times are logged (throws if the Stage was remounted since recordDraws). */
const drawMark = () =>
  page.evaluate(() => {
    const log = window.drawLog!;
    if (window.eyespyStage?.stats !== log.stats) throw new Error("the Stage was remounted: draw log lost");
    return { draws: log.stats.draws, logged: log.ms.length };
  });
/** The draw times logged between two marks. */
const drawsSince = (from: { logged: number }, to: { logged: number }) =>
  page.evaluate(([a, b]) => window.drawLog!.ms.slice(a, b), [from.logged, to.logged] as const);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};
const summary = (xs: number[]) => ({
  n: xs.length,
  median: +pct(xs, 50).toFixed(2),
  p95: +pct(xs, 95).toFixed(2),
  max: +Math.max(...xs).toFixed(2),
});

/** RSS of every process of this browser, meaning all Chromium processes whose command line names our user data dir. */
function browserRss(marker: string) {
  let kb = 0,
    n = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes(marker)) continue;
      const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) {
        kb += Number(m[1]);
        n++;
      }
    } catch {}
  }
  return { mb: Math.round(kb / 1024), processes: n };
}
const marker = o.profile ? path.resolve(o.profile) : "playwright_chromiumdev_profile";

const metrics: Record<string, unknown> = { video, prompt: PROMPT, diskMB: o["disk-mb"] ?? "default" };
/** How many "encoded frame" engine logs so far (one per keyframe encoded). */
const encodes = () =>
  page.evaluate(
    () =>
      (window.eyespyEvents as { kind: string; text?: string }[]).filter(
        (e) => e.kind === "log" && /^encoded frame/.test(e.text ?? ""),
      ).length,
  );
const session = `full-${Date.now()}`;
await page.goto(`${srv.url}/?models=/models&runtime=/nm&session=${session}`);
await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 120_000 });
step("add the full clip");
const tAdd = Date.now();
await page.setInputFiles("#empty-video", video);
await page.waitForFunction(
  () => window.eyespyUI.state().frames > 0 || !!document.querySelector("dialog[open] .unsupported-video"),
  null,
  { timeout: 3_600_000, polling: 1000 },
);
if (await page.$("dialog[open] .unsupported-video"))
  throw new Error(`this browser can't decode ${path.basename(video)}: convert it to H.264 MP4 first`);
const addSeconds = (Date.now() - tAdd) / 1000;
await idle();
const n = (await state()).frames;
metrics.add = { seconds: +addSeconds.toFixed(1), keyframes: n };
step(`${n} keyframes after ${addSeconds.toFixed(0)} s (keyframe picking + frame extraction)`);
const tThumbs = Date.now();
await page.waitForFunction(
  () =>
    document.querySelectorAll(".filmstrip .thumb img").length >= document.querySelectorAll(".filmstrip .thumb").length,
  null,
  { timeout: 300_000, polling: 250 },
);
metrics.filmstrip = {
  thumbs: await page.locator(".filmstrip .thumb").count(),
  allThumbsSeconds: +((Date.now() - tThumbs) / 1000).toFixed(1),
};
await snap("full-added", `Full clip (${path.basename(video)}): ${n} keyframes in ${addSeconds.toFixed(0)} s.`);

step(`find ${PROMPT} on all ${n} keyframes`);
const featuresBeforeFind = await api("features");
const encodesBeforeFind = await encodes();
await recordDraws();
const before = await drawMark();
const tFind = Date.now();
await page.fill("#prompt-input", PROMPT);
await page.click("form.promptbar button[type=submit]");
await page.waitForFunction(() => window.eyespyUI.state().busy?.startsWith("Finding"), null, { timeout: 30_000 });
// sample UI responsiveness while the find runs, as the main-thread latency of a no-op task
const lag: number[] = [];
while ((await state()).busy) {
  lag.push(
    await page.evaluate(
      () =>
        new Promise<number>((r) => {
          const t = performance.now();
          setTimeout(() => r(performance.now() - t), 0);
        }),
    ),
  );
  await page.waitForTimeout(500);
}
await idle();
const findSeconds = (Date.now() - tFind) / 1000;
const st = await api("status");
const afterFind = await drawMark();
const findDrawMs = await drawsSince(before, afterFind);
metrics.find = {
  seconds: +findSeconds.toFixed(1),
  perFrame: +(findSeconds / n).toFixed(2),
  detections: st.detections,
  todo: st.todo,
  mainThreadTaskLatencyMs: summary(lag),
  draws: afterFind.draws - before.draws,
  drawMs: summary(findDrawMs),
  encodes: (await encodes()) - encodesBeforeFind,
  featuresBefore: featuresBeforeFind,
  featuresAfter: await api("features"),
};
step(`find: ${findSeconds.toFixed(0)} s, ${st.detections} detections, ${st.todo} todo`);
await snap(
  "full-found",
  `“${PROMPT}” over all ${n} keyframes: ${st.detections} detections (${st.todo} unassigned) in ${findSeconds.toFixed(0)} s.`,
);

// the busiest keyframe
const dets = (await api("data.dets", { mask: "none" })).dets;
// the find's detections, to diff runs against each other
writeFileSync(
  path.join(OUT, "full-dets.json"),
  JSON.stringify(dets.map((d) => ({ id: d.id, score: d.score, box: d.box }))) + "\n",
);
const perFrame = new Map<number, number>();
for (const d of dets) perFrame.set(d.frame, (perFrame.get(d.frame) ?? 0) + 1);
const busiest = [...perFrame].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
metrics.busiestFrame = { frame: busiest, detections: perFrame.get(busiest) ?? 0 };

// data refresh cost at this size (every edit ends in one)
const refreshMs: number[] = [];
for (let k = 0; k < 5; k++)
  refreshMs.push(
    await page.evaluate(async () => {
      const t = performance.now();
      await window.eyespyUI.refresh();
      return performance.now() - t;
    }),
  );
metrics.refreshMs = summary(refreshMs);
// the engine side of it: each query a refresh sends, alone
metrics.refreshOpsMs = await page.evaluate(async () => {
  const ops: [string, unknown][] = [
    ["status", {}],
    ["data.dets", { mask: "none" }],
    ["data.objects", undefined],
    ["data.runs", undefined],
    ["data.history", undefined],
  ];
  const out: Record<string, number> = {};
  for (const [op, input] of ops) {
    const xs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      await window.eyespy!.call(op, input);
      xs.push(performance.now() - t);
    }
    out[op] = +(xs.sort((a, b) => a - b)[2] ?? NaN).toFixed(1);
  }
  return out;
});

// stepping through every keyframe in turn. Times each key press until the image is drawn, and counts the draws until
// then. The draw times are all draws of the stepping phase, late ones too, such as masks arriving after the image.
step("keyframe stepping");
await page.evaluate(() => window.eyespyUI.setFrame(0));
await page.waitForTimeout(500);
const beforeSteps = await drawMark();
const stepMs: number[] = [],
  stepDraws: number[] = [];
for (let k = 0; k < n - 1; k++) {
  const r = await page.evaluate(async () => {
    const s = window.eyespyStage!.stats;
    const ui = window.eyespyUI.state();
    const frames: readonly number[] = ui.frameNumbers;
    const target = frames[frames.indexOf(ui.frame) + 1];
    const draws0 = s.draws;
    const t = performance.now();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    for (;;) {
      await new Promise((res) => requestAnimationFrame(res));
      if (s.bitmapFrame === target) return { ms: performance.now() - t, draws: s.draws - draws0 };
      if (performance.now() - t > 10_000) return { ms: NaN, draws: s.draws - draws0 };
    }
  });
  stepMs.push(r.ms);
  stepDraws.push(r.draws);
}
const afterSteps = await drawMark();
const stepDrawMs = await drawsSince(beforeSteps, afterSteps);
metrics.stepToImageMs = summary(stepMs.filter((x) => !Number.isNaN(x)));
metrics.stepping = {
  steps: stepMs.length,
  timedOut: stepMs.filter((x) => Number.isNaN(x)).length,
  draws: afterSteps.draws - beforeSteps.draws,
  drawsToImage: summary(stepDraws),
  drawMs: summary(stepDrawMs),
  /** Each step's ms from key press to image, in keyframe order, to show which steps are slow. */
  ms: stepMs.map((x) => +x.toFixed(1)),
};
metrics.drawMs = summary([...findDrawMs, ...stepDrawMs]);

// hover with pointermove over the busiest frame's regions. Times the handler (pick and redraw) and the time to the
// next frame.
step("hover latency");
await page.evaluate((f) => window.eyespyUI.setFrame(f), busiest);
await page.waitForTimeout(1500);
const hover = await page.evaluate(async (f) => {
  const r = await window.eyespy!.data.dets({ frames: String(f), mask: "none" });
  const c = document.querySelector(".stage canvas") as HTMLCanvasElement;
  const handler: number[] = [],
    frame: number[] = [];
  let hits = 0;
  for (let rep = 0; rep < 3; rep++)
    for (const d of r.dets as readonly { box: readonly [number, number, number, number] }[]) {
      const p = window.eyespyStage!.toClient((d.box[0] + d.box[2]) / 2, (d.box[1] + d.box[3]) / 2);
      const t = performance.now();
      c.dispatchEvent(new PointerEvent("pointermove", { clientX: p.x, clientY: p.y, bubbles: true }));
      handler.push(performance.now() - t);
      await new Promise((res) => requestAnimationFrame(res));
      frame.push(performance.now() - t);
      if (document.querySelector(".tip")) hits++;
    }
  return { handler, frame, hits, regions: r.dets.length };
}, busiest);
metrics.hover = {
  regions: hover.regions,
  tooltips: hover.hits,
  handlerMs: summary(hover.handler),
  toNextFrameMs: summary(hover.frame),
};
await snap(
  "full-busiest",
  `The busiest keyframe (#${busiest}, ${perFrame.get(busiest)} detections), after the hover measurements (synthetic pointer moves over each region).`,
);

step("triage");
const tTri = Date.now();
await page.click('button:has-text("Start triage")');
await page.waitForFunction(() => window.eyespyUI.state().triage !== null, null, { timeout: 120_000 });
const tri = (await state()).triage!;
metrics.triage = { firstGroupSeconds: +((Date.now() - tTri) / 1000).toFixed(2), groups: tri.groups };
const tSkip = Date.now();
await page.keyboard.press("s");
await page.waitForFunction((off) => (window.eyespyUI.state().triage?.offset ?? -1) > off, tri.offset, {
  timeout: 120_000,
});
(metrics.triage as Record<string, number>).skipSeconds = +((Date.now() - tSkip) / 1000).toFixed(2);
await page.waitForTimeout(800);
await snap("full-triage", `Triage at full scale: ${tri.groups} look-alike groups.`);
// an object across the clip. Press A or N on the first group, then the filmstrip marks it.
await page.keyboard.press("n");
await idle();
await page.click('#panel-triage button:has-text("Stop")');
const obj = (await api("data.objects")).objects[0];
if (obj) {
  await page.click(`button.obj-row[data-obj="${obj.id}"]`);
  await page.waitForTimeout(800);
  await snap(
    "full-object",
    `Object ${obj.id} on the full clip: the filmstrip and slider mark its ${obj.sightings} keyframes.`,
  );
}

if (o.repeat) {
  // a second full find needs every keyframe's features again. It reads them back where the budget kept them, and
  // encodes the rest.
  step(`repeat: find ${o.repeat} on all ${n} keyframes`);
  const featuresBefore = await api("features");
  const enc0 = await encodes();
  const t = Date.now();
  await page.fill("#prompt-input", o.repeat);
  await page.click("form.promptbar button[type=submit]");
  await page.waitForFunction(() => window.eyespyUI.state().busy?.startsWith("Finding"), null, { timeout: 30_000 });
  await idle();
  const seconds = (Date.now() - t) / 1000;
  metrics.repeatFind = {
    prompt: o.repeat,
    seconds: +seconds.toFixed(1),
    encodes: (await encodes()) - enc0,
    featuresBefore,
    featuresAfter: await api("features"),
  };
  step(`repeat find: ${seconds.toFixed(0)} s, ${JSON.stringify(metrics.repeatFind)}`);
}

step("memory and storage");
const mem = await page.evaluate(
  () => (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory,
);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const pm = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
metrics.memory = {
  pageJsHeapMB: mem ? Math.round(mem.usedJSHeapSize / 2 ** 20) : null,
  domNodes: pm.Nodes,
  browserRss: browserRss(marker),
};
const storage = await page.evaluate(async (name) => {
  type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };
  const size = async (d: Dir, filter?: (path: string) => boolean, rel = ""): Promise<number> => {
    let n = 0;
    for await (const [k, h] of d.entries()) {
      const p = rel ? `${rel}/${k}` : k;
      if (h.kind === "file") {
        if (!filter || filter(p)) n += (await (h as FileSystemFileHandle).getFile()).size;
      } else n += await size(h as Dir, filter, p);
    }
    return n;
  };
  const root = (await navigator.storage.getDirectory()) as Dir;
  const s = (await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(name)) as Dir;
  const est = await navigator.storage.estimate();
  const mb = (x: number) => Math.round(x / 2 ** 20);
  return {
    estimateMB: mb(est.usage ?? 0),
    quotaMB: mb(est.quota ?? 0),
    sessionMB: mb(await size(s)),
    featuresMB: mb(await size(s, (p) => p.includes("/feat/"))),
    framesMB: mb(await size(s, (p) => p.includes("/frames/"))),
    detsMB: mb(await size(s, (p) => p.includes("/dets/"))),
    modelsMB: mb(await size((await root.getDirectoryHandle("models")) as Dir)),
  };
}, session);
metrics.opfs = storage;
const clips = (await api("clips.list")).clips;
metrics.clipsList = clips.map((c) => ({
  name: c.name,
  keyframes: c.keyframes,
  MB: Math.round(((c.frame_bytes ?? 0) + (c.feature_bytes ?? 0)) / 2 ** 20),
}));

console.log(JSON.stringify(metrics, null, 1));
writeFileSync(path.join(OUT, "full-metrics.json"), JSON.stringify(metrics, null, 1) + "\n");
d.finish();
assert.ok((metrics.find as { detections: number }).detections > 0);
// leave the app before closing. A persistent profile restores its last tab, and a restored app tab reopens (and
// writes to) this session while --drop below removes it (InvalidModificationError, or a stub directory comes back).
if (o.drop) await page.goto(`${srv.url}/blank`);
await close();
if (o.drop) {
  // from a fresh browser, because while the closed page's worker lived, a removal failed part way or the directory
  // came back
  const again = await launch({ userDataDir: o.profile });
  await again.page.goto(`${srv.url}/blank`);
  // right after the browser closed, a recursive removal can fail part way (InvalidModificationError). The next try
  // removes what is left.
  let err = "";
  for (let k = 0; k < 10; k++) {
    err = await again.page.evaluate(async (name) => {
      const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions");
      return sessions.removeEntry(name, { recursive: true }).then(
        () => "",
        (e: unknown) => (e instanceof DOMException && e.name === "NotFoundError" ? "" : String(e)),
      );
    }, session);
    if (!err) break;
    step(`drop ${session}: ${err}; retrying`);
    await again.page.waitForTimeout(3000);
  }
  await again.close();
  if (err) throw new Error(`could not drop OPFS session ${session}: ${err}`);
  step(`dropped OPFS session ${session}`);
}
srv.close();
console.log(`${d.problems.length ? "done with page problems" : "ok"} (${d.elapsed().toFixed(0)} s)`);
