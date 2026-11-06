/**
 * Video tracking end to end on the built debug page, in the product's worker. It adds a clip with tracking on, starts
 * one detection through router calls, sends a Find while units run, pauses, reloads, resumes, reads masks on a frame
 * that isn't a keyframe, and takes rAF readings. It dumps trunks, seed and masks for a comparison with PyTorch.
 *
 *   EYESPY_MODELS=scratch/models-tracker node --import tsx scripts/tracking.ts <video> <prompt> [--profile dir]
 *     [--out dir] [--precision fp16|fp32] [--limit frames per leg to dump]
 *
 * It needs `vite build` first and the graphs under tracker/ and vision/ in the model folder.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { launch, must, pageMounts, scratch, serve } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string" },
    out: { type: "string" },
    precision: { type: "string" },
    limit: { type: "string" },
  },
});
const [video, prompt] = positionals;
if (!video || !prompt) throw new Error("usage: tracking.ts <video> <prompt>");
const out = o.out ?? scratch("tracking-e2e");
const limit = Number(o.limit ?? 12);
mkdirSync(out, { recursive: true });

const srv = await serve(pageMounts());
const { page, close } = await launch({ userDataDir: o.profile });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const session = `tracking-${Date.now()}`;
const base = `${srv.url}/?debug&models=/models&runtime=/nm&session=${session}`;
const url = `${base}&tracker${o.precision === "fp32" ? "=fp32" : ""}`;
const say = (...a: unknown[]) => console.log(...a);
const seconds = (t0: number) => ((Date.now() - t0) / 1000).toFixed(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ready = () => page.evaluate(() => window.eyespyReady!.then(() => true));
const status = () => page.evaluate(() => window.eyespy!.track.status());
const open = async (u: string) => {
  await page.goto(u);
  await ready();
};

/** rAF intervals and a WebGL fence on the page, as a user's canvas would feel the GPU. */
const installMeter = () =>
  page.evaluate(() => {
    const w = globalThis as any;
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 270;
    document.body.append(c);
    const gl = c.getContext("webgl2")!;
    const m = (w.METER = { on: false, dt: [] as number[], fence: [] as number[] });
    let last = 0,
      sync: WebGLSync | null = null,
      syncAt = 0;
    const tick = () => {
      if (!sync) return;
      const st = gl.clientWaitSync(sync, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        if (m.on) m.fence.push(performance.now() - syncAt);
        gl.deleteSync(sync);
        sync = null;
      } else setTimeout(tick, 1);
    };
    const raf = (now: number) => {
      if (m.on && last) m.dt.push(now - last);
      last = now;
      gl.clearColor(Math.sin(now / 300) * 0.5 + 0.5, 0.2, 0.3, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!sync) {
        sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        syncAt = performance.now();
        setTimeout(tick, 1);
      }
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  });
const meter = async (label: string, ms: number) => {
  await page.evaluate(() => {
    const m = (globalThis as any).METER;
    m.dt = [];
    m.fence = [];
    m.on = true;
  });
  await sleep(ms);
  const r = await page.evaluate(() => {
    const m = (globalThis as any).METER;
    m.on = false;
    const q = (v: number[], p: number) => v.toSorted((a, b) => a - b)[Math.floor(p * (v.length - 1))] ?? 0;
    const total = m.dt.reduce((a: number, b: number) => a + b, 0) / 1000;
    return {
      n: m.dt.length,
      fps: +(m.dt.length / (total || 1)).toFixed(1),
      p50: +q(m.dt, 0.5).toFixed(1),
      p95: +q(m.dt, 0.95).toFixed(1),
      p99: +q(m.dt, 0.99).toFixed(1),
      max: +q(m.dt, 1).toFixed(1),
      over33: m.dt.filter((x: number) => x > 33.4).length,
      over100: m.dt.filter((x: number) => x > 100).length,
      fence_p50: +q(m.fence, 0.5).toFixed(1),
      fence_p95: +q(m.fence, 0.95).toFixed(1),
      fence_max: +q(m.fence, 1).toFixed(1),
    };
  });
  say(`jank ${label}: ${JSON.stringify(r)}`);
  return r;
};

const rleArea = (counts: readonly number[]) => counts.reduce((a, c, k) => a + (k % 2 ? c : 0), 0);
/** RLE counts as a 288² plane, as `rle` makes them: runs alternating from 0. */
const rlePlane = (counts: readonly number[]) => {
  const plane = new Uint8Array(288 * 288);
  let at = 0;
  counts.forEach((c, k) => {
    if (k % 2) plane.fill(1, at, at + c);
    at += c;
  });
  return plane;
};

// Set up: the clip, its keyframes encoded, a seed in the middle of the clip.
await open(url);
await page.evaluate(() => {
  const i = document.createElement("input");
  i.type = "file";
  i.id = "testvideo";
  document.body.append(i);
});
await page.setInputFiles("#testvideo", video);
let t0 = Date.now();
const added = await page.evaluate(() => {
  const file = (document.getElementById("testvideo") as HTMLInputElement).files?.[0];
  return window.eyespy!.addFile(must(file));

  function must<T>(v: T | undefined): T {
    if (!v) throw new Error("no file");
    return v;
  }
});
say(`add: ${seconds(t0)} s, ${added.keyframes} keyframes`);
const clip = (await page.evaluate(() => window.eyespy!.clips.list({}))).clips[0]?.key;
if (!clip) throw new Error("no clip");
const grid = await page.evaluate((c) => window.eyespy!.track.frames({ clip: c }), clip);
say(`grid: ${grid.frames.length} frames, ${grid.frames.filter((f) => f.keyframe !== null).length} keyframes on it`);
const frameCheck = await page.evaluate(() => window.eyespy!.data.frames());
if (frameCheck.frames.length !== added.keyframes) throw new Error("tracking frames leaked into the frame list");

t0 = Date.now();
await page.evaluate(() => window.eyespy!.track.pause());
for (;;) {
  const st = await page.evaluate(() => window.eyespy!.status());
  if (st.encoded >= st.keyframes) break;
  await sleep(500);
}
say(
  `keyframes encoded through the parts in ${seconds(t0)} s (${((Date.now() - t0) / 1000 / added.keyframes).toFixed(2)} s each)`,
);

const mid = must(
  grid.frames.filter((f) => f.keyframe !== null)[Math.floor(added.keyframes / 2)]?.keyframe,
  "a keyframe in the middle",
);
t0 = Date.now();
const found = await page.evaluate(([p, f]) => window.eyespy!.find({ prompt: p, frames: f, threshold: 0.3 }), [
  prompt,
  String(mid),
] as const);
say(`first find (loads text and detector): ${seconds(t0)} s, ${found.hits.length} hits`);
const hit = must(found.hits[0], `a hit for ${prompt} on keyframe ${mid}`);
say(`seed: detection ${hit.id}, score ${hit.score}, area ${hit.area}`);

// Baseline, then units running.
await installMeter();
await meter("paused, no tracking units", 8000);
await page.evaluate((id) => window.eyespy!.track.start({ ids: [id], first: true }), hit.id);
await page.evaluate(() => window.eyespy!.track.resume());
await sleep(15000);
const after15 = (await status()).tracks[0];
say(`after 15 s: ${after15?.done}/${after15?.total} frames (forward ${after15?.forward}, reverse ${after15?.reverse})`);
const running = await meter("tracking units running", 15000);

// A Find jumps in: its time against the same kind of Find with no units running.
const reached = (await status()).tracks[0]?.done ?? 0;
t0 = Date.now();
const f1 = await page.evaluate((f) => window.eyespy!.find({ prompt: "apple", frames: f }), String(mid));
const during = Date.now() - t0;
const progressed = ((await status()).tracks[0]?.done ?? 0) - reached;
say(`find while units run: ${during} ms, ${progressed} frames tracked meanwhile, ${f1.hits.length} hits`);

// Pause, for real.
const paused = await page.evaluate(() => window.eyespy!.track.pause());
const stopAt = paused.tracks[0]?.done;
await sleep(3000);
const still = (await status()).tracks[0]?.done;
say(`paused at ${stopAt}, 3 s later ${still}`);
if (stopAt !== still) throw new Error("units ran while paused");
t0 = Date.now();
await page.evaluate((f) => window.eyespy!.find({ prompt: "pear", frames: f }), String(mid));
say(`find while paused: ${Date.now() - t0} ms`);

// Reload: still paused, nothing lost.
await page.reload();
await ready();
const reloaded = await status();
say(`after reload: paused ${reloaded.paused}, ${reloaded.tracks[0]?.done} frames`);
if (!reloaded.paused || reloaded.tracks[0]?.done !== still) throw new Error("the reload lost state");
await sleep(3000);
if ((await status()).tracks[0]?.done !== still) throw new Error("units ran after the reload while paused");

// Resume to the end.
await page.evaluate(() => window.eyespy!.track.resume());
t0 = Date.now();
for (;;) {
  const t = (await status()).tracks[0];
  if (t?.finished || t?.state !== "active") break;
  if (Date.now() - t0 > 600_000) throw new Error(`stuck at ${JSON.stringify(t)}`);
  await sleep(2000);
}
const end = must((await status()).tracks[0], "the track");
const rate = (end.total - (still ?? 0)) / ((Date.now() - t0) / 1000);
say(`finished: ${JSON.stringify(end)}; ${rate.toFixed(2)} frames/s through encode and track`);
if (end.state !== "active") throw new Error(end.failure ?? "failed");

// Masks on a frame that isn't a keyframe.
const nonKey = must(
  grid.frames.find((f) => f.keyframe === null && f.at > end.seed_at),
  "a frame past the seed that isn't a keyframe",
);
const onFrame = await page.evaluate(([c, a]) => window.eyespy!.track.masks({ clip: c, at: a }), [
  clip,
  nonKey.at,
] as const);
const row = must(onFrame.masks[0], "a mask");
if (row.mask?.format !== "rle") throw new Error("expected rle");
say(
  `mask on non-keyframe at ${nonKey.at} (t=${nonKey.t}): area ${rleArea(row.mask.counts)} of 288², score ${row.score.toFixed(2)}, iou ${row.iou.toFixed(3)}`,
);

// Dump for the comparison with PyTorch.
const readBytes = (key: string) =>
  page.evaluate(async (k) => {
    const b = await window.eyespy!.port.readFile(k);
    if (!b) return null;
    let s = "";
    for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
    return btoa(s);
  }, key);
const dump = path.join(out, "dump");
mkdirSync(dump, { recursive: true });
const places = grid.frames.map((f) => f.at).filter((a) => Math.abs(a - end.seed_at) <= limit);
for (const at of places) {
  const r = await page.evaluate(([c, a]) => window.eyespy!.track.masks({ clip: c, at: a }), [clip, at] as const);
  const m = r.masks[0]?.mask;
  if (m?.format !== "rle") throw new Error(`no mask at ${at}`);
  writeFileSync(path.join(dump, `mask_${at}.u8`), rlePlane(m.counts));
  const name = String(at).padStart(3, "0");
  const trunk = await readBytes(`clips/${clip}/trunk/${name}.f16`);
  writeFileSync(path.join(dump, `trunk_${at}.f16`), Buffer.from(must(trunk, `trunk ${at}`), "base64"));
  const place = grid.frames[at];
  const jpeg = await readBytes(
    place?.keyframe !== null && place?.keyframe !== undefined
      ? `clips/${clip}/frames/${String(grid.frames.slice(0, at).filter((f) => f.keyframe !== null).length).padStart(3, "0")}.jpg`
      : `clips/${clip}/trackframes/${name}.jpg`,
  );
  if (jpeg) writeFileSync(path.join(dump, `frame_${at}.jpg`), Buffer.from(jpeg, "base64"));
}
writeFileSync(
  path.join(dump, "meta.json"),
  JSON.stringify({ seedAt: end.seed_at, total: end.total, places, det: hit.id, running }),
);
say(`dumped ${places.length} frames to ${dump}`);

// Without ?tracker the same session opens as it does in production.
const asked: string[] = [];
page.on("request", (r) => {
  if (r.url().includes("/models/")) asked.push(new URL(r.url()).pathname);
});
await open(base);
const off = await page.evaluate(() =>
  window.eyespy!.track.status().then(
    () => "on",
    (e: Error) => e.message,
  ),
);
const plain = await page.evaluate(() => window.eyespy!.status());
say(`without ?tracker: track.status says "${off}", ${plain.keyframes} keyframes, ${plain.encoded} encoded`);
const wrong = asked.filter((a) => a.includes("/tracker/") || a.includes("/vision/"));
if (wrong.length) throw new Error(`asked for ${wrong.join(", ")}`);

if (errors.length) say(`page errors: ${errors.join(" | ")}`);
await close();
srv.close();
say("done");
