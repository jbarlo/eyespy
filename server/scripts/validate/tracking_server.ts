/**
 * Video tracking on the real server: a folder of frames with its fps, one detection tracked, the server stopped and
 * started again, tracking resumed, masks read on a frame that isn't a keyframe.
 *
 *   EYESPY_MODELS=scratch/models-tracker EYESPY_SERVER=... server/scripts/validate/gpu.sh \
 *     server/scripts/validate/tracking_server.ts <video> <prompt> [units before the restart]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { framesOf } from "./frames.ts";
import { createSession, startTs } from "./lib.ts";

const [video, prompt, before = "6"] = process.argv.slice(2);
if (!video || !prompt) throw new Error("usage: tracking_server.ts <video> <prompt> [frames]");
const { dir, fps } = framesOf(video);
const root = mkdtempSync(path.join(tmpdir(), "eyespy-track-"));
createSession(root);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const first = await startTs(root, ["--tracker"]);
const add = await first.c.add({ video: dir, fps });
console.log(`added ${dir} at ${fps} fps: ${add.keyframes} keyframes`);
const clip = (await first.c.clips_list({})).clips[0]?.key;
if (!clip) throw new Error("no clip");
const grid = await first.c.track_frames({ clip });
console.log(`grid: ${grid.frames.length} frames, ${grid.frames.filter((f) => f.keyframe !== null).length} keyframes`);

const found = await first.c.find({ prompt, frames: "0-99", threshold: 0.3 });
const hit = found.hits[0];
if (!hit) throw new Error(`no ${prompt}`);
console.log(`seed ${hit.id}, score ${hit.score}`);
await first.c.track_start({ ids: [hit.id], first: true });
const t0 = Date.now();
for (;;) {
  const t = (await first.c.track_status({})).tracks[0];
  if (t?.state !== "active") throw new Error(JSON.stringify(t));
  if (t.done >= Number(before) || t.finished) break;
  await sleep(500);
}
const paused = await first.c.track_pause({});
const reached = paused.tracks[0]?.done ?? 0;
console.log(`paused at ${reached} frames after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
first.proc.kill();
await sleep(1000);

const again = await startTs(root, ["--tracker"]);
const st = await again.c.track_status({});
console.log(`after a restart: paused ${st.paused}, ${st.tracks[0]?.done} frames`);
if (!st.paused || st.tracks[0]?.done !== reached) throw new Error("the restart lost state");
await again.c.track_resume({});
for (let k = 0; k < 40; k++) {
  await sleep(500);
  const t = (await again.c.track_status({})).tracks[0];
  if ((t?.done ?? 0) >= reached + 3 || t?.finished) break;
}
const s = await again.c.track_cancel({});
const t = s.tracks[0];
console.log(`cancelled at ${t?.done}/${t?.total} frames`);
if ((t?.done ?? 0) <= reached) throw new Error("resuming did nothing");

const covered = grid.frames.find((f) => f.keyframe === null && f.at <= (t?.forward ?? 0) && f.at >= (t?.reverse ?? 0));
if (!covered) throw new Error("no covered frame that isn't a keyframe");
const m = await again.c.track_masks({ clip, at: covered.at });
const row = m.masks[0];
if (row?.mask.format !== "rle") throw new Error("no mask");
const area = row.mask.counts.reduce((a, c, k) => a + (k % 2 ? c : 0), 0);
console.log(`mask at ${covered.at} (t=${covered.t}): area ${area} of 288², score ${row.score.toFixed(2)}`);
again.proc.kill();
rmSync(root, { recursive: true, force: true });
console.log("done");
