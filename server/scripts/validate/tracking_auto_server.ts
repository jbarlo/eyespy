/**
 * Auto tracking on the real server: a folder of frames, a find, `track.auto`, `track.proposals`, and the session's
 * bytes by kind. It stops at the budget, paused, and reports how far it got.
 *
 *   EYESPY_MODELS=scratch/models-tracker EYESPY_SERVER=... server/scripts/validate/gpu.sh \
 *     server/scripts/validate/tracking_auto_server.ts <video> <prompt> [seconds]
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { framesOf } from "./frames.ts";
import { createSession, startTs } from "./lib.ts";

const [video, prompt, seconds = "300"] = process.argv.slice(2);
if (!video || !prompt) throw new Error("usage: tracking_auto_server.ts <video> <prompt> [seconds]");
const { dir, fps } = framesOf(video);
const root = mkdtempSync(path.join(tmpdir(), "eyespy-auto-"));
createSession(root);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { c, proc } = await startTs(root, ["--tracker"]);
const add = await c.add({ video: dir, fps });
console.log(`added ${dir} at ${fps} fps: ${add.keyframes} keyframes`);
const found = await c.find({ prompt });
console.log(`find ${prompt}: ${found.hits.length} hits`);
const t0 = Date.now();
const auto = await c.track_auto({});
console.log(`track.auto: ${auto.tracks.length} tracks, ${auto.waiting} keyframes waiting`);
for (;;) {
  const s = await c.track_status({});
  const left = s.waiting > 0 || s.tracks.some((t) => t.state === "active" && !t.finished);
  if (!left || Date.now() - t0 > Number(seconds) * 1000) break;
  await sleep(2000);
}
const paused = await c.track_pause({});
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const done = paused.tracks.reduce((a, t) => a + t.done, 0);
const total = paused.tracks.reduce((a, t) => a + t.total, 0);
const failed = paused.tracks.filter((t) => t.state === "failed").map((t) => [t.id, t.failure]);
console.log(`after ${secs} s: ${paused.tracks.length} tracks, ${done}/${total} frames, ${paused.waiting} waiting`);
console.log(`finished ${paused.tracks.filter((t) => t.finished).length}, failed ${JSON.stringify(failed)}`);
const p = await c.track_proposals({});
const shown = p.groups.map((g) => g.tracks.map((t) => [t.track, t.dets.length, t.score, t.frames?.count]));
console.log(`proposals: ${p.groups.length} groups ${JSON.stringify(shown)}`);
console.log(`left out ${p.left_out.length}, weak covers ${p.weak_covers}, waiting ${p.waiting}`);
const clip = (await c.clips_list({})).clips[0];
console.log(`clip row: ${JSON.stringify(clip?.tracking)}`);
const eyespy = path.join(root, ".eyespy");
const files = readdirSync(eyespy, { recursive: true, encoding: "utf8" }).map((f) => statSync(path.join(eyespy, f)));
const bytes = files.filter((f) => f.isFile()).reduce((a, f) => a + f.size, 0);
console.log(`session folder: ${(bytes / 2 ** 20).toFixed(0)} MB`);
proc.kill();
rmSync(root, { recursive: true, force: true });
console.log("done");
