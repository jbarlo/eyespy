/**
 * First-visit check of a deployed app. Opens <url> in a fresh profile with no local models or runtime, agrees to the
 * SAM License through its dialog, adds a clip, runs one find, and prints the bytes fetched from each origin.
 *   node --import tsx scripts/live.ts <url> <h264 clip> [--prompt jar] [--out dir] [--profile dir]
 * --profile reuses a browser profile (and its model cache) instead of a fresh one under <out>.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { driver, launch, scratch } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: "string" },
    out: { type: "string" },
    profile: { type: "string" },
  },
});
const [url, video] = positionals;
if (!url || !video) throw new Error("usage: live.ts <url> <h264 clip> [--prompt jar] [--out dir] [--profile dir]");
const OUT = o.out ?? scratch(`web-live-${Date.now()}`);
const PROMPT = o.prompt ?? "jar";
mkdirSync(OUT, { recursive: true });

const { page, close } = await launch({
  userDataDir: o.profile ?? mkdtempSync(path.join(OUT, "profile-")),
  agreeSam: false,
});
await page.setViewportSize({ width: 1280, height: 800 });
const bytes = new Map<string, number>();
page.context().on("requestfinished", (r) => {
  void r
    .sizes()
    .then((s) => {
      const origin = new URL(r.url()).origin;
      bytes.set(origin, (bytes.get(origin) ?? 0) + s.responseBodySize);
    })
    .catch(() => {});
});
const d = driver(page, OUT);
const { snap, step, state, idle, api } = d;

step(`open ${url}`);
await page.goto(url);
// the engine starts only after the licence is answered
await page.waitForSelector(".dialog.licence", { timeout: 120_000 });
await snap("licence", "First visit: the SAM License dialog, before anything is downloaded.");
await page.click(".dialog.licence button.primary");
await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 600_000 });
await snap("open", "The engine is ready.");

step("add the video");
await page.setInputFiles("#empty-video", video);
await page.waitForFunction(() => window.eyespyUI.state().frames > 0, null, { timeout: 1_800_000, polling: 1000 });
await idle(1_800_000, 1000);
await page.waitForFunction(() => window.eyespyUI.state().downloads.length === 0, null, {
  timeout: 1_800_000,
  polling: 1000,
});
step(`${(await state()).frames} keyframes`);
await page.waitForTimeout(1500);
await snap("video-added", "The clip's keyframes, after the model downloads.");

step(`find ${PROMPT}`);
await page.fill("#prompt-input", PROMPT);
await page.click("form.promptbar button[type=submit]");
await page.waitForFunction(() => window.eyespyUI.state().busy?.startsWith("Finding"), null, { timeout: 30_000 });
await idle(1_800_000, 1000);
const st = await api("status");
step(`${st.detections} detections`);
await page.waitForTimeout(500);
await snap("found", `Results for “${PROMPT}”.`);
assert.ok(st.detections > 0, "find produced detections");

console.log("bytes fetched per origin:");
for (const [origin, n] of [...bytes].sort((a, b) => b[1] - a[1]))
  console.log(`  ${(n / 1e6).toFixed(1).padStart(8)} MB  ${origin}`);
console.log(`screenshots in ${OUT}`);
d.finish();
await close();
