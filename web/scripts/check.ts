/**
 * Browser and Node parity. Adds the video in headless Chromium (WebGPU) and to a Node server session, runs
 * `find <prompt>` on some keyframes, and compares the detections by mask IoU. Needs `pnpm build` first.
 *
 *   node --import tsx scripts/check.ts --video V [--prompt jar] [--frames 0-3] [--node-session DIR] [--profile DIR]
 *     [--detector fp32] [--threshold 0.5] [--min-match 0.8] [--json FILE]
 *
 * V must be a format Chromium decodes natively, such as H.264 MP4. The Node side reads every frame of V as JPEGs,
 * so keyframe times can differ. The script reports them, and fails when fewer than half agree or when it matches fewer
 * than --min-match of the Node detections. DIR's socket path must stay under the 108-byte unix socket limit, so from a
 * worktree, don't put it under the worktree.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Outputs } from "eyespy-core/api";
import { unrle } from "eyespy-core/detections/pure";
import { maskArea, maskIou, type MeasuredMask } from "eyespy-core/pixels";
import { SESSION_FILE, SESSION_MARKER } from "eyespy-core/storage/marker";
import { framesOf } from "../../server/scripts/validate/frames.ts";
import { createSession, startTs, tsClient } from "../../server/scripts/validate/lib.ts";
import { WEB, launch, pageMounts, serve } from "./harness.ts";

const { values: o } = parseArgs({
  options: {
    video: { type: "string" },
    prompt: { type: "string", default: "jar" },
    frames: { type: "string", default: "0-3" },
    threshold: { type: "string", default: "0.5" },
    "node-session": { type: "string", default: path.join(process.env.TMPDIR ?? "/tmp", "eyespy-check-node-h264") },
    profile: { type: "string" },
    detector: { type: "string", default: "fp32" },
    "min-match": { type: "string", default: "0.8" },
    json: { type: "string" },
  },
});
const threshold = Number(o.threshold);
if (!o.video) {
  console.error("usage: check.ts --video V [--prompt jar] [--frames 0-3] [--node-session DIR] [--profile DIR]");
  process.exit(2);
}
const video = o.video;

async function nodeSide() {
  const dir = o["node-session"];
  if (!existsSync(path.join(dir, SESSION_MARKER, SESSION_FILE))) createSession(dir);
  const folder = framesOf(video); // before any server starts, so a failed extraction leaves none behind
  const running = tsClient(dir);
  const started = (await running.status({}).catch(() => null)) ? null : await startTs(dir, ["--detector", o.detector]);
  const c = started?.c ?? running;
  try {
    const st = await c.status({});
    const t0 = Date.now();
    if (!st.clips.length) await c.add({ video: folder.dir, fps: folder.fps });
    const addS = (Date.now() - t0) / 1000;
    const t1 = Date.now();
    await c.find({ prompt: o.prompt, frames: o.frames });
    const findS = (Date.now() - t1) / 1000;
    const { frames } = await c.data_frames({});
    const { dets } = await c.data_dets({ frames: o.frames, prompt: o.prompt, threshold, mask: "rle" });
    const { runs } = await c.data_runs({ frames: o.frames, prompt: o.prompt });
    // relative to .eyespy, which webSide serves at /nodesession
    const images = frames.map((f) => path.relative(path.join(dir, SESSION_MARKER), f.image));
    return { frames, images, dets, runs, addS, findS };
  } finally {
    if (started) await c.shutdown().catch(() => started.proc.kill());
  }
}

async function webSide(nodeImages: readonly string[]) {
  if (!existsSync(path.join(WEB, "dist", "index.html"))) throw new Error("build first: pnpm --filter eyespy-web build");
  const srv = await serve(pageMounts({ "/nodesession": path.join(o["node-session"], ".eyespy") }));
  const { page, close } = await launch({ userDataDir: o.profile });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const t0 = Date.now();
    await page.goto(`${srv.url}/?debug&models=/models&runtime=/nm&session=check-${Date.now()}&detector=${o.detector}`);
    await page.evaluate(() => window.eyespyReady!.then(() => true));
    const readyS = (Date.now() - t0) / 1000;
    await page.evaluate(() => {
      const i = document.createElement("input");
      i.type = "file";
      i.id = "testvideo";
      document.body.append(i);
    });
    await page.setInputFiles("#testvideo", video);
    const t1 = Date.now();
    const add = await page.evaluate(() => {
      const file = (document.getElementById("testvideo") as HTMLInputElement).files?.[0];
      if (!file) throw new Error("no file in #testvideo");
      return window.eyespy!.addFile(file);
    });
    const addS = (Date.now() - t1) / 1000;
    const t2 = Date.now();
    await page.evaluate(([p, f]) => window.eyespy!.find({ prompt: p, frames: f }), [o.prompt, o.frames] as const);
    const findS = (Date.now() - t2) / 1000;
    const data = await page.evaluate(
      async ([p, f, th]) => {
        const v = window.eyespy!;
        return {
          frames: (await v.data.frames()).frames.map((f) => f as typeof f & { imageKey: string }),
          dets: (await v.data.dets({ frames: f, prompt: p, threshold: th, mask: "rle" })).dets,
          runs: (await v.data.runs({ frames: f, prompt: p })).runs,
          events: window.eyespyEvents.filter((e) => e.kind !== "log" || /loaded|encoded|added|grey/.test(e.text)),
        };
      },
      [o.prompt, o.frames, threshold] as const,
    );
    // the browser's and the Node session's keyframe JPEG of the same keyframe number, compared as decoded pixels
    const pixels = await page.evaluate(
      async (frames: { frame: number; t: number; imageKey: string; node: string | null }[]) => {
        const rgba = async (blob: Blob) => {
          const bm = await createImageBitmap(blob, { colorSpaceConversion: "none" });
          const c = new OffscreenCanvas(bm.width, bm.height);
          const g = c.getContext("2d")!;
          g.drawImage(bm, 0, 0);
          return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data };
        };
        const out = [];
        for (const f of frames) {
          const r = f.node === null ? null : await fetch(`/nodesession/${f.node}`);
          if (!r?.ok) {
            out.push({ frame: f.frame, nodeFile: false });
            continue;
          }
          const a = await rgba(await r.blob());
          const b = await rgba(await (await fetch((await window.eyespy!.file(f.imageKey))!)).blob());
          if (a.w !== b.w || a.h !== b.h) {
            out.push({ frame: f.frame, size: [a.w, a.h, b.w, b.h] });
            continue;
          }
          let s = 0,
            s2 = 0,
            n = 0;
          for (let i = 0; i < a.d.length; i++) {
            if ((i & 3) === 3) continue;
            const e = a.d[i]! - b.d[i]!;
            s += Math.abs(e);
            s2 += e * e;
            n++;
          }
          out.push({
            frame: f.frame,
            mae: +(s / n).toFixed(2),
            psnr: +(10 * Math.log10((255 * 255) / (s2 / n))).toFixed(1),
          });
        }
        return out;
      },
      (data.frames.slice(0, 4) as { frame: number; t: number; imageKey: string }[]).map((f) => ({
        ...f,
        node: nodeImages[f.frame] ?? null,
      })),
    );
    const net = srv.bytes();
    return { ...data, pixels, add, readyS, addS, findS, errors, servedMB: Math.round(net / 2 ** 20) };
  } finally {
    await close();
    srv.close();
  }
}

type Det = Outputs["data.dets"]["dets"][number];
/** Decodes a detection's RLE mask (data.dets with mask: "rle") and counts it for maskIou. */
function measured(d: Det): MeasuredMask {
  if (d.mask?.format !== "rle") throw new Error(`${d.id}: no RLE mask`);
  const mask = unrle(d.mask.counts, d.mask.w * d.mask.h);
  return { box: d.box, mask, area: maskArea(mask) };
}

const node = await nodeSide();
const web = await webSide(node.images);
const frames = [...new Set(node.dets.map((d) => d.frame).concat(web.dets.map((d) => d.frame)))].sort((a, b) => a - b);
const report: Record<string, unknown>[] = [];
let matchedAll = 0,
  nodeAll = 0;
const ious: number[] = [],
  sdiffs: number[] = [];
for (const f of frames.length ? frames : [0]) {
  const tn = node.frames[f]?.t,
    tw = web.frames[f]?.t;
  const nd = node.dets.filter((d) => d.frame === f),
    wd = web.dets.filter((d) => d.frame === f);
  const nm = nd.map(measured),
    wm = wd.map(measured);
  const pairs: [number, number, number][] = [];
  nm.forEach((a, i) =>
    wm.forEach((b, j) => {
      const v = maskIou(a, b);
      if (v > 0.5) pairs.push([v, i, j]);
    }),
  );
  pairs.sort((x, y) => y[0] - x[0]);
  const ui = new Set<number>(),
    uj = new Set<number>();
  const fi: number[] = [],
    fs: number[] = [];
  for (const [v, i, j] of pairs) {
    if (ui.has(i) || uj.has(j)) continue;
    ui.add(i);
    uj.add(j);
    fi.push(v);
    fs.push(Math.abs(nd[i]!.score - wd[j]!.score));
  }
  matchedAll += fi.length;
  nodeAll += nd.length;
  ious.push(...fi);
  sdiffs.push(...fs);
  const pn = node.runs.find((r) => r.frame === f)?.presence,
    pw = web.runs.find((r) => r.frame === f)?.presence;
  report.push({
    frame: f,
    t: { node: tn, web: tw },
    node: nd.length,
    web: wd.length,
    matched: fi.length,
    meanIoU: fi.length ? +(fi.reduce((a, b) => a + b, 0) / fi.length).toFixed(4) : null,
    minIoU: fi.length ? +Math.min(...fi).toFixed(4) : null,
    maxScoreDiff: fs.length ? +Math.max(...fs).toFixed(3) : null,
    presence: { node: pn, web: pw },
    unmatchedNode: nd.filter((_, i) => !ui.has(i)).map((d) => `${d.id}@${d.score}`),
    unmatchedWeb: wd.filter((_, j) => !uj.has(j)).map((d) => `${d.id}@${d.score}`),
  });
}
const summary = {
  video,
  prompt: o.prompt,
  frames: o.frames,
  detector: o.detector,
  threshold,
  keyframes: {
    node: node.frames.length,
    web: web.frames.length,
    sameTimes: node.frames.length === web.frames.length && node.frames.every((f, i) => f.t === web.frames[i]?.t),
    commonTimes: node.frames.filter((f) => web.frames.some((g) => g.t === f.t)).length,
    nodeTimes: node.frames.map((f) => f.t).join(" "),
    webTimes: web.frames.map((f) => f.t).join(" "),
  },
  matched: `${matchedAll}/${nodeAll} node detections (web has ${web.dets.length})`,
  meanIoU: ious.length ? +(ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(4) : null,
  minIoU: ious.length ? +Math.min(...ious).toFixed(4) : null,
  maxScoreDiff: sdiffs.length ? +Math.max(...sdiffs).toFixed(3) : null,
  seconds: { node: { add: node.addS, find: node.findS }, web: { ready: web.readyS, add: web.addS, find: web.findS } },
  servedMB: web.servedMB,
  keyframePixels: web.pixels,
  pageErrors: web.errors,
};
console.log(JSON.stringify({ summary, frames: report }, null, 1));
console.log(
  web.events
    .map((e) => (e.kind === "log" ? e.text : e.kind === "download" && e.done ? `${e.name}: ${e.source}` : null))
    .filter(Boolean)
    .join("\n"),
);
if (o.json)
  writeFileSync(
    o.json,
    JSON.stringify({ summary, frames: report, node: { frames: node.frames.length }, webEvents: web.events }, null, 1),
  );
const commonTimes = node.frames.filter((f) => web.frames.some((g) => g.t === f.t)).length;
process.exit(commonTimes < node.frames.length / 2 || matchedAll < Number(o["min-match"]) * nodeAll ? 1 : 0);
