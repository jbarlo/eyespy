/**
 * Auto tracking end to end on the built debug page, in steps that can stop and go on. Each step opens the same session
 * in the same browser profile and goes on from what it finds: clip added, keyframes encoded, prompts found, tracks
 * queued, tracks run. It leaves tracking paused when its time is up. When nothing is left it dumps the grid, cuts,
 * proposals, status and every track's mask on every frame, for the report in scratch.
 *
 *   EYESPY_MODELS=scratch/models-tracker node --import tsx scripts/tracking_auto.ts <video> --session name --out dir
 *     [--profile dir] [--prompts car,person] [--seconds 780] [--recheck 1.5] [--max 32] [--reload-after 40]
 *     [--seed-last] [--add-only]
 *
 * --seed-last starts one track by hand on the largest hit on the last keyframe, instead of auto tracking. --add-only
 * reports the clip's grid and cuts and stops. It needs `vite build` first.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { launch, must, pageMounts, serve } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    out: { type: "string" },
    profile: { type: "string" },
    prompts: { type: "string" },
    seconds: { type: "string" },
    recheck: { type: "string" },
    max: { type: "string" },
    "reload-after": { type: "string" },
    "seed-last": { type: "boolean" },
    "add-only": { type: "boolean" },
  },
});
const [video] = positionals;
if (!video || !o.session || !o.out) throw new Error("usage: tracking_auto.ts <video> --session name --out dir");
const out = o.out;
mkdirSync(out, { recursive: true });
const prompts = (o.prompts ?? "").split(",").filter(Boolean);
const budget = Number(o.seconds ?? 780) * 1000;
const started = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s]`, ...a);

// A fixed port keeps the origin, and with it a persistent profile's copy of the models.
const srv = await serve(pageMounts(), Number(process.env.EYESPY_WEB_PORT ?? 41908));
const { page, close } = await launch({ userDataDir: o.profile });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.text().includes("can't decode") || m.text().includes("track ")) say("page:", m.text());
});
const url = `${srv.url}/?debug&models=/models&runtime=/nm&session=${o.session}&detector=fp16&tracker`;
const ready = () => page.evaluate(() => window.eyespyReady!.then(() => true));
const status = () => page.evaluate(() => window.eyespy!.track.status());
await page.goto(url);
await ready();

const finish = async (code = 0) => {
  if (errors.length) say(`page errors: ${errors.join(" | ")}`);
  await close();
  srv.close();
  process.exit(code);
};

// The clip.
const listed = await page.evaluate(() => window.eyespy!.clips.list({}));
if (!listed.clips.length) {
  if (o.recheck) {
    const v = Number(o.recheck);
    await page.evaluate((x) => window.eyespy!.config({ key: "track_recheck", value: x }), v);
  }
  if (o.max) {
    const v = Number(o.max);
    await page.evaluate((x) => window.eyespy!.config({ key: "auto_tracks", value: x }), v);
  }
  await page.evaluate(() => window.eyespy!.track.pause());
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.type = "file";
    i.id = "testvideo";
    document.body.append(i);
  });
  await page.setInputFiles("#testvideo", video);
  const t0 = Date.now();
  const added = await page
    .evaluate(() => {
      const file = (document.getElementById("testvideo") as HTMLInputElement).files?.[0];
      if (!file) throw new Error("no file");
      return window.eyespy!.addFile(file);
    })
    .catch((e: Error) => {
      say(`add failed: ${e.message}`);
      return null;
    });
  if (!added) await finish(3);
  say(`add: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${added?.keyframes} keyframes`);
}
const clip = must((await page.evaluate(() => window.eyespy!.clips.list({}))).clips[0]?.key, "a clip");
const grid = await page.evaluate((c) => window.eyespy!.track.frames({ clip: c }), clip);
const keyframes = grid.frames.filter((f) => f.keyframe !== null);
say(`grid: ${grid.frames.length} frames, ${keyframes.length} keyframes, cuts ${JSON.stringify(grid.cuts)}`);
writeFileSync(path.join(out, "grid.json"), JSON.stringify({ video, ...grid }));
if (o["add-only"]) await finish();

// Keyframes encoded, prompts found. Paused until then: Find has the GPU to itself.
for (;;) {
  const st = await page.evaluate(() => window.eyespy!.status());
  if (st.encoded >= st.keyframes) break;
  if (Date.now() - started > budget) {
    say(`out of time at ${st.encoded}/${st.keyframes} keyframes encoded`);
    await finish();
  }
  await sleep(500);
}
const queued = (await status()).tracks.length > 0 || (await status()).waiting > 0;
if (!queued) {
  for (const prompt of prompts) {
    const t0 = Date.now();
    const f = await page.evaluate((p) => window.eyespy!.find({ prompt: p }), prompt);
    say(`find ${prompt}: ${f.hits.length} hits in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    writeFileSync(path.join(out, `hits_${prompt}.json`), JSON.stringify(f.hits));
  }
  if (o["seed-last"]) {
    const last = must(keyframes.at(-1)?.keyframe, "a last keyframe");
    const f = await page.evaluate(([p, k]) => window.eyespy!.find({ prompt: p, frames: k }), [
      must(prompts[0], "a prompt"),
      String(last),
    ] as const);
    const hit = must(f.hits.toSorted((a, b) => b.area - a.area)[0], "a hit on the last keyframe");
    say(`seed on the last keyframe: ${hit.id}, score ${hit.score}, area ${hit.area}`);
    await page.evaluate((id) => window.eyespy!.track.start({ ids: [id], first: true }), hit.id);
  } else await page.evaluate(() => window.eyespy!.track.auto({}));
}

// Run. Progress goes to a log, so a later step adds to the same record.
await page.evaluate(() => window.eyespy!.track.resume());
const t0 = Date.now();
const every = 5000;
let reloaded = o["reload-after"] === undefined;
const done = (s: Awaited<ReturnType<typeof status>>) =>
  s.waiting === 0 && s.tracks.every((t) => t.finished || t.state !== "active");
const progress: unknown[] = [];
for (;;) {
  const s = await status();
  const line = {
    ms: Date.now() - t0,
    tracks: s.tracks.length,
    waiting: s.waiting,
    done: s.tracks.reduce((a, t) => a + t.done, 0),
    skipped: s.tracks.reduce((a, t) => a + t.skipped, 0),
    parked: s.tracks.filter((t) => t.parked).length,
    finished: s.tracks.filter((t) => t.finished).length,
    failed: s.tracks.filter((t) => t.state === "failed").map((t) => [t.id, t.failure]),
  };
  progress.push(line);
  if (done(s)) break;
  if (!reloaded && line.done >= Number(o["reload-after"])) {
    reloaded = true;
    const before = JSON.stringify(s.tracks.map((t) => [t.id, t.det]));
    const t1 = Date.now();
    await page.reload();
    await ready();
    const after = await status();
    say(`reload at ${line.done} frames, ${s.waiting} keyframes waiting: back in ${Date.now() - t1} ms`);
    say(`  waiting ${after.waiting}, done ${after.tracks.reduce((a, t) => a + t.done, 0)}`);
    const same = before === JSON.stringify(after.tracks.slice(0, s.tracks.length).map((t) => [t.id, t.det]));
    if (!same) throw new Error("the reload changed the tracks");
  }
  if (Date.now() - started > budget) {
    await page.evaluate(() => window.eyespy!.track.pause());
    say(`out of time: ${JSON.stringify(line)}`);
    writeFileSync(path.join(out, `progress_${started}.json`), JSON.stringify(progress));
    await finish();
  }
  await sleep(every);
}
const wall = (Date.now() - t0) / 1000;
say(`nothing left after ${wall.toFixed(0)} s in this step: ${JSON.stringify(progress.at(-1))}`);
writeFileSync(path.join(out, `progress_${started}.json`), JSON.stringify(progress));

// Dump.
const final = await status();
const proposals = await page.evaluate(() => window.eyespy!.track.proposals());
writeFileSync(path.join(out, "status.json"), JSON.stringify(final, null, 1));
writeFileSync(path.join(out, "proposals.json"), JSON.stringify(proposals, null, 1));
const assoc = await page.evaluate(async () => {
  const b = await window.eyespy!.port.readFile("assoc.json");
  return b ? new TextDecoder().decode(b) : null;
});
if (assoc) writeFileSync(path.join(out, "assoc.json"), assoc);
const masks = path.join(out, "masks");
mkdirSync(masks, { recursive: true });
const rlePlane = (counts: readonly number[]) => {
  const plane = new Uint8Array(288 * 288);
  let at = 0;
  counts.forEach((c, k) => {
    if (k % 2) plane.fill(1, at, at + c);
    at += c;
  });
  return plane;
};
const rows: unknown[] = [];
for (const f of grid.frames) {
  const r = await page.evaluate(([c, a]) => window.eyespy!.track.masks({ clip: c, at: a }), [clip, f.at] as const);
  rows.push({
    at: f.at,
    t: f.t,
    keyframe: f.keyframe,
    parked: r.parked,
    masks: r.masks.map((m) => ({ track: m.track, score: m.score, iou: m.iou })),
  });
  for (const m of r.masks) {
    if (m.mask.format !== "rle") throw new Error("expected rle");
    writeFileSync(path.join(masks, `${f.at}_${m.track}.u8`), rlePlane(m.mask.counts));
  }
}
writeFileSync(path.join(out, "frames.json"), JSON.stringify(rows));

// The grid's pictures, for contact sheets.
const pics = path.join(out, "pics");
mkdirSync(pics, { recursive: true });
const readBytes = (key: string) =>
  page.evaluate(async (k) => {
    const b = await window.eyespy!.port.readFile(k);
    if (!b) return null;
    let s = "";
    for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
    return btoa(s);
  }, key);
for (const f of grid.frames) {
  const name = String(f.at).padStart(3, "0");
  const before = grid.frames.slice(0, f.at).filter((x) => x.keyframe !== null).length;
  const key =
    f.keyframe !== null
      ? `clips/${clip}/frames/${String(before).padStart(3, "0")}.jpg`
      : `clips/${clip}/trackframes/${name}.jpg`;
  const b = await readBytes(key);
  if (b) writeFileSync(path.join(pics, `${name}.jpg`), Buffer.from(b, "base64"));
}
say(`dumped ${grid.frames.length} frames to ${out}`);
writeFileSync(path.join(out, "DONE"), "");
await finish();
