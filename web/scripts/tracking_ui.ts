/**
 * Video tracking through the real GUI, by clicks and drags on the built page, with frame timing per stretch and the
 * tracking stores' sizes at the end. It needs `vite build` first and a fixed EYESPY_WEB_PORT, so reopening finds the
 * same browser storage. Set HEADLESS=0 for a visible window.
 *
 *   EYESPY_MODELS=scratch/models-tracker node --import tsx scripts/tracking_ui.ts run <video> --prompts car,person
 *     --session name --out dir --profile dir [--seconds 800] [--detector fp32]
 *   ... tracking_ui.ts control <video> --prompts jar --session name --out dir --profile dir
 *
 * `jank` is frame timing alone, with a spot on the page repainted every frame, as an idle page presents nothing and so
 * shows no contention with the GPU work.
 *
 * `control` opens without the flag and checks that nothing about tracking shows or loads, then opens the same session
 * with the flag, where the clip counts as keyframes-only, and prepares it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "playwright-core";
import { launch, must, pageMounts, serve } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompts: { type: "string" },
    session: { type: "string" },
    out: { type: "string" },
    profile: { type: "string" },
    seconds: { type: "string" },
    detector: { type: "string" },
    other: { type: "string" },
  },
});
const [mode, video] = positionals;
if (!video || !o.session || !o.out || !o.profile || (mode !== "run" && mode !== "control" && mode !== "jank"))
  throw new Error(
    "usage: tracking_ui.ts run|control|jank <video> --prompts a,b --session name --out dir --profile dir",
  );
const out = o.out;
mkdirSync(out, { recursive: true });
const prompts = (o.prompts ?? "").split(",").filter(Boolean);
const budget = Number(o.seconds ?? 800) * 1000;
const started = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const results: Record<string, unknown> = { video, prompts, detector: o.detector ?? "app default" };
const record = (k: string, v: unknown) => {
  results[k] = v;
  say(k, JSON.stringify(v));
  writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 1));
};
const left = () => budget - (Date.now() - started);

const srv = await serve(pageMounts());
const { page, close } = await launch({ userDataDir: o.profile });
await page.setViewportSize({ width: 1500, height: 900 });
const errors: string[] = [];
const requests: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/onnxruntime|VerifyEachNode|constant_folding|BoxParser/.test(m.text()))
    errors.push(m.text().slice(0, 300));
});
page.on("request", (r) => requests.push(new URL(r.url()).pathname));
let shot = 0;
const snap = async (name: string) => {
  const file = `${String(++shot).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(out, file) });
  say("shot", file);
};

/** Frame timing and long tasks into window globals, from before the page's own scripts. */
const timing = () => {
  const w = window as unknown as { __raf: number[]; __long: number[]; __marks: [string, number][] };
  w.__raf = [];
  w.__long = [];
  w.__marks = [];
  const tick = (t: number) => {
    w.__raf.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__long.push(e.startTime, e.duration);
  }).observe({ type: "longtask", buffered: true });
};
await page.addInitScript(timing);

type Timing = {
  label: string;
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over33: number;
  over100: number;
  long: number;
  longMax: number;
  seconds: number;
};
/** Timing over `run`, from the window's rAF log: gaps between frames, and long tasks on the page's main thread. */
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = await page.evaluate(() => performance.now());
  const r = await run();
  const g = await page.evaluate((t0) => {
    const w = window as unknown as { __raf: number[]; __long: number[] };
    const raf = w.__raf.filter((t) => t >= t0);
    const long: number[] = [];
    for (let k = 0; k + 1 < w.__long.length; k += 2) if ((w.__long[k] ?? 0) >= t0) long.push(w.__long[k + 1] ?? 0);
    return { raf, long, now: performance.now() };
  }, start);
  const gaps = g.raf
    .slice(1)
    .map((t, k) => t - (g.raf[k] ?? t))
    .toSorted((a, b) => a - b);
  const q = (x: number) => Math.round((gaps[Math.floor(x * (gaps.length - 1))] ?? 0) * 10) / 10;
  const t: Timing = {
    label,
    seconds: Math.round((g.now - start) / 100) / 10,
    frames: gaps.length,
    p50: q(0.5),
    p95: q(0.95),
    max: q(1),
    over33: gaps.filter((x) => x > 33).length,
    over100: gaps.filter((x) => x > 100).length,
    long: g.long.length,
    longMax: Math.round(Math.max(0, ...g.long)),
  };
  ((results.timing ??= []) as Timing[]).push(t);
  say("timing", JSON.stringify(t));
  writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 1));
  return r;
}

const status = () => page.evaluate(() => window.eyespy!.track.status());
const sum = (s: Awaited<ReturnType<typeof status>>) => s.tracks.reduce((a, t) => a + t.done, 0);
const phase = () => page.locator("[data-track-phase]").getAttribute("data-track-phase", { timeout: 15_000 });
const open = async (flag: boolean) => {
  const url = `${srv.url}/?models=/models&runtime=/nm&session=${o.session}${o.detector ? `&detector=${o.detector}` : ""}${flag ? "&tracker" : ""}`;
  await page.goto(url);
  await page.evaluate(() => window.eyespyReady!.then(() => true));
};
const add = async (p: Page) => {
  const t0 = Date.now();
  await p.setInputFiles("#empty-video, #videos-add", video);
  await p.waitForSelector(".stage canvas", { timeout: 300_000 });
  await p.waitForFunction(() => !window.eyespyUI.state().busy, null, { timeout: 300_000 });
  return Date.now() - t0;
};
const encoded = async () => {
  for (;;) {
    const s = await page.evaluate(() => window.eyespy!.status());
    if (s.encoded >= s.keyframes || left() < 0) return s;
    await sleep(500);
  }
};
const find = async (prompt: string) => {
  const t0 = Date.now();
  await page.fill("#prompt-input", prompt);
  await page.click(".promptbar button[type=submit]");
  await sleep(50);
  await page.waitForFunction(() => !window.eyespyUI.state().busy, null, { timeout: 600_000, polling: 100 });
  return Date.now() - t0;
};
/** Moves the tracked-frames slider as a drag does. */
const scrubTo = async (at: number) => {
  await page.evaluate((x) => {
    const el = document.querySelector<HTMLInputElement>("[data-track-slider]")!;
    el.value = String(x);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, at);
};
const placeText = () => page.locator("[data-track-place]").innerText();
const storage = async () => {
  const opfs = await page.evaluate(async () => {
    const out: Record<string, { files: number; bytes: number }> = {};
    const walk = async (d: FileSystemDirectoryHandle, p: string): Promise<void> => {
      for await (const [name, h] of d as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, `${p}/${name}`);
        else {
          const f = await (h as FileSystemFileHandle).getFile();
          const key = p
            .replace(/\/tracks\/t\d+$/, "/tracks")
            .replace(/^(\/sessions?\/[^/]+)\/clips\/[0-9a-f]+/, "$1/clip");
          const row = (out[key] ??= { files: 0, bytes: 0 });
          row.files++;
          row.bytes += f.size;
        }
      }
    };
    await walk(await navigator.storage.getDirectory(), "");
    return { dirs: out, estimate: await navigator.storage.estimate() };
  });
  const t0 = Date.now();
  const clips = await page.evaluate(() => window.eyespy!.clips.list({}));
  return { opfs, clips: clips.clips, listMs: Date.now() - t0 };
};
const between = async () => {
  const s = await status();
  const c = must(s.tracks[0], "a track");
  const grid = await page.evaluate((k) => window.eyespy!.track.frames({ clip: k }), c.clip);
  return {
    clip: c.clip,
    spot: grid.frames.find((f) => f.keyframe === null && f.at > c.reverse && f.at < c.forward),
    grid,
  };
};
const finish = async (code = 0) => {
  record("errors", errors);
  await close();
  srv.close();
  process.exit(code);
};

if (mode === "control") {
  await open(false);
  record("addMs", await add(page));
  await encoded();
  record("findMs", await find(must(prompts[0], "a prompt")));
  await snap("control-no-flag");
  const shown = await page.evaluate(() => ({
    panel: document.querySelector("#panel-tracking") !== null,
    slider: document.querySelector("[data-track-slider]") !== null,
    stat: document.querySelector("[data-tracking-stat]") !== null,
    text: /track/i.test(document.body.innerText),
    legend: document.querySelector(".legend-unsure") !== null,
  }));
  record("control", {
    shown,
    trackerRequests: requests.filter((r) => /\/models\/(tracker|vision)\//.test(r)),
    trackingOff: await page.evaluate(() =>
      window.eyespy!.track.status().then(
        () => "on",
        (e: Error) => e.message,
      ),
    ),
    files: await page.evaluate(async () => {
      const list = await window.eyespy!.clips.list({});
      return list.clips.map((c) => ("tracking" in c ? "has tracking field" : "no tracking field"));
    }),
  });
  // the same session with the flag: the clip has no frames between keyframes
  await open(true);
  await page.waitForSelector("[data-keyframes-only]", { timeout: 30_000 });
  await snap("keyframes-only-flag");
  await find(must(prompts[0], "a prompt"));
  record("keyframesOnlyAfterFind", await status());
  if (o.other) {
    await page.setInputFiles("[data-prepare-clip] input", o.other);
    await sleep(3000);
    await page.waitForFunction(() => !window.eyespyUI.state().busy, null, { timeout: 300_000 });
    record("wrongFile", await page.evaluate(() => window.eyespyUI.state().errors));
    await snap("prepare-wrong-file");
  }
  const t0 = Date.now();
  await page.setInputFiles("[data-prepare-clip] input", video);
  await sleep(500);
  await page.waitForFunction(() => !window.eyespyUI.state().busy, null, { timeout: 300_000 });
  record("prepareMs", Date.now() - t0);
  await sleep(2500);
  await snap("prepared");
  record("afterPrepare", {
    flag: await page.locator("[data-keyframes-only]").count(),
    grid: await placeText().catch(() => null),
    status: (await status()).tracks.length,
    waiting: (await status()).waiting,
  });
  await page.click("[data-track-pause]", { timeout: 20_000 }).catch(() => say("nothing to pause"));
  await finish();
}

if (mode === "jank") {
  await open(true);
  record("addMs", await add(page));
  await encoded();
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;right:4px;top:4px;width:12px;height:12px;z-index:99";
    document.body.append(d);
    let n = 0;
    const paint = () => {
      n++;
      d.style.background = n % 2 ? "#f0f" : "#0ff";
      d.style.transform = `translateX(${n % 3}px)`;
      requestAnimationFrame(paint);
    };
    paint();
  });
  await timed("repainting, nothing running, 10 s", () => sleep(10_000));
  record("find1Ms", await timed(`first find ${prompts[0]}`, () => find(must(prompts[0], "a prompt"))));
  record(
    "handsOff",
    await timed("first pass of frames, hands off, 30 s", async () => {
      const a0 = sum(await status());
      await sleep(30_000);
      return { doneBefore: a0, doneAfter: sum(await status()), phase: await phase() };
    }),
  );
  const grid = (await between()).grid;
  const sweep = () =>
    timed("scrubbing with draws", async () => {
      for (let k = 0; k < 60; k++) {
        await scrubTo(Math.round(((k % 20) / 19) * (grid.frames.length - 1)));
        await sleep(100);
      }
    });
  await sweep();
  const oneFrame = () =>
    (async () => {
      await page.selectOption(".promptbar select", "frame");
      const ms = await find(must(prompts[0], "a prompt"));
      await page.selectOption(".promptbar select", "all");
      return ms;
    })();
  record("oneFrameQueuedMs", await timed("find on this frame, queue running", oneFrame));
  record("newPromptQueuedMs", await timed("find a new prompt, all keyframes, queue running", () => find("person")));
  await page.click("[data-track-pause]");
  await page.waitForSelector("[data-track-resume]", { timeout: 60_000 });
  await timed("paused, hands off, 10 s", () => sleep(10_000));
  await sweep();
  record("oneFramePausedMs", await timed("find on this frame, paused", oneFrame));
  record("newPromptPausedMs", await timed("find a new prompt, all keyframes, paused", () => find("window")));
  await page.click("[data-track-cancel]");
  await finish();
}

// One clip, end to end.
await open(true);
await snap("empty");
const already = (await page.evaluate(() => window.eyespy!.clips.list({}))).clips.length > 0;
if (!already) record("addMs", await add(page));
await timed("encoding keyframes, no tracking", encoded);
await snap("added");

record("find1Ms", await timed(`first find ${prompts[0]}`, () => find(must(prompts[0], "a prompt"))));
await snap("found-first");
const firstStart = Date.now();
// the slow first stretch
await page.waitForSelector("[data-tracking-stat]", { timeout: 60_000 });
await sleep(4000);
await snap("preparing");
record("phaseEarly", { phase: await phase(), text: await page.locator(".track-summary").innerText() });

// masks at a frame between keyframes, as soon as there are some
const waitSpot = async () => {
  for (;;) {
    const b = await between();
    if (b.spot || left() < 0) return b;
    await sleep(1000);
  }
};
// the worst stretch for the page: frames being read for the first time, with nobody touching anything
const handsOff = await timed("first pass of frames, hands off, 25 s", async () => {
  const a0 = sum(await status());
  await sleep(25_000);
  return { doneBefore: a0, doneAfter: sum(await status()), phase: await phase() };
});
record("handsOff", handsOff);
const b = await waitSpot();
record("firstBetweenAfterMs", Date.now() - firstStart);
if (b.spot) {
  await scrubTo(b.spot.at);
  await page
    .waitForFunction(
      () => /[1-9]\d* masks?/.test(document.querySelector("[data-track-place]")?.textContent ?? ""),
      null,
      { timeout: 20_000 },
    )
    .catch(() => say("no masks text"));
  await sleep(300);
  await snap("between-frame-masks");
  record("betweenFrame", {
    at: b.spot.at,
    keyframe: b.spot.keyframe,
    text: await placeText(),
    masks: (
      await page.evaluate(([c, a]) => window.eyespy!.track.masks({ clip: c, at: a }), [b.clip, b.spot.at] as const)
    ).masks.map((m) => [m.track, Math.round(m.score * 10) / 10, m.mask.format === "rle" ? m.mask.counts.length : 0]),
  });
}

// a real click on the slider, as a person would
{
  const box = must(await page.locator("[data-track-slider]").boundingBox(), "the slider");
  await page.mouse.click(box.x + box.width * 0.08, box.y + box.height / 2);
  await sleep(1500);
  record("sliderClick", await placeText());
}

// scrub timing while the queue runs: a sweep over the grid
const n = b.grid.frames.length;
await timed("queue running, scrubbing back and forth", async () => {
  for (let k = 0; k < 40; k++) {
    await scrubTo(Math.round(((k % 20) / 19) * (n - 1)));
    await sleep(100);
  }
});
const lat: number[] = [];
for (let k = 0; k < 6; k++) {
  const at = Math.floor(((k + 0.5) / 6) * (n - 1));
  const t0 = await page.evaluate(() => performance.now());
  const v = await page.evaluate(
    ([c, a]) => window.eyespy!.track.masks({ clip: c, at: a }).then((m) => [performance.now(), m.masks.length]),
    [b.clip, at] as const,
  );
  lat.push(Math.round((v[0] ?? 0) - t0));
  await sleep(300);
}
record("masksOpLatencyMsWhileQueued", lat);

// more prompts: a Find while the queue runs goes ahead of it
for (const p of prompts.slice(1)) {
  const before = sum(await status());
  record(`findDuringQueue ${p}`, {
    ms: await timed(`find ${p} while queue runs`, () => find(p)),
    before,
    after: sum(await status()),
  });
  await snap(`found-${p}`);
}
const oneFrame = await timed("find on this frame only, queue running", async () => {
  await page.selectOption(".promptbar select", "frame");
  const ms = await find(must(prompts[0], "a prompt"));
  await page.selectOption(".promptbar select", "all");
  return ms;
});
record("findOneFrameDuringQueueMs", oneFrame);

// select: it goes first
await sleep(6000);
const s1 = await status();
record("afterFinds", { tracks: s1.tracks.length, waiting: s1.waiting, done: sum(s1) });
const q1 = s1.tracks.filter((t) => t.state === "active" && !t.finished);
const later = q1.filter((t) => t.priority === Math.max(...q1.map((x) => x.priority))).at(-1) ?? q1.at(-1);
if (later && q1.length > 1) {
  const row = page.locator(`[data-track="${later.id}"] .track-pick`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await sleep(500);
  const before = (await status()).tracks.find((t) => t.id === later.id);
  await sleep(8000);
  await snap("selected-goes-first");
  const after = await status();
  const others = after.tracks.filter((t) => t.id !== later.id && s1.tracks.find((x) => x.id === t.id)?.done !== t.done);
  record("selectGoesFirst", {
    track: later.id,
    priority: after.tracks.find((t) => t.id === later.id)?.priority,
    doneBefore: before?.done,
    doneAfter: after.tracks.find((t) => t.id === later.id)?.done,
    first: await page.locator(`[data-track="${later.id}"]`).getAttribute("data-first"),
    note: await page
      .locator("[data-track-note]")
      .innerText()
      .catch(() => null),
    othersMoved: others.length,
  });
  await page.keyboard.press("Escape");
}

// pause: work stops, and the GUI stays usable
await page.click("[data-track-pause]");
await page.waitForSelector("[data-track-resume]", { timeout: 60_000 });
const p0 = sum(await status());
await sleep(1500);
await snap("paused");
await timed("paused, hands off, 10 s", () => sleep(10_000));
const p1 = sum(await status());
const usable = await timed("paused, scrubbing and stepping", async () => {
  const t0 = Date.now();
  await page.click(".scrub > button:nth-of-type(2)");
  await scrubTo(Math.floor(n / 2));
  await sleep(500);
  await page.click(".scrub > button:nth-of-type(2)");
  return Date.now() - t0;
});
// the same finds with nothing else running, to compare with those during the queue
const baseline = await timed("find on this frame only, paused", async () => {
  await page.selectOption(".promptbar select", "frame");
  const ms = await find(must(prompts[0], "a prompt"));
  await page.selectOption(".promptbar select", "all");
  return ms;
});
record("findOneFramePausedMs", baseline);
const lastPrompt = must(prompts.at(-1), "a prompt");
record("findAllPausedMs", await timed(`find ${lastPrompt} again, all keyframes, paused`, () => find(lastPrompt)));
record("findNewPausedMs", await timed("find a new prompt, all keyframes, paused", () => find("window")));
record("pause", { doneAtPause: p0, doneAfter10s: p1, stopped: p0 === p1, phase: await phase(), usableMs: usable });
await page.click("[data-track-resume]");
await sleep(5000);
const r1 = sum(await status());
record("resume", { done: r1, moved: r1 > p1, phase: await phase() });

// reload mid-track: it carries on
const before = await status();
const t1 = Date.now();
await page.reload();
await page.evaluate(() => window.eyespyReady!.then(() => true));
const back = await status();
await sleep(8000);
const moved = await status();
await snap("after-reload");
record("reload", {
  doneBefore: sum(before),
  doneRightAfter: sum(back),
  doneLater: sum(moved),
  tracks: [before.tracks.length, back.tracks.length],
  ms: Date.now() - t1 - 8000,
  phase: await phase(),
});

// stop everything, and start it again
await page.click("[data-track-cancel]");
await page.waitForSelector("[data-track-again]", { timeout: 60_000 });
const c0 = await status();
await sleep(5000);
const c1 = await status();
await snap("stopped");
record("cancel", {
  done: sum(c0),
  doneLater: sum(c1),
  states: [...new Set(c1.tracks.map((t) => t.state))],
  waiting: c1.waiting,
  phase: await phase(),
});
const first = c1.tracks.at(-1);
if (first) {
  await page.locator(`[data-track="${first.id}"] .track-pick`).click();
  await sleep(1500);
  record("selectStopped", {
    state: (await status()).tracks.find((t) => t.id === first.id)?.state,
    note: await page
      .locator("[data-track-note]")
      .innerText()
      .catch(() => null),
  });
  await page.keyboard.press("Escape");
}
await page.click("[data-track-again]");
await sleep(3000);
record("started again", { phase: await phase(), states: [...new Set((await status()).tracks.map((t) => t.state))] });

// to the end, as far as the budget goes
const done = (s: Awaited<ReturnType<typeof status>>) =>
  s.waiting === 0 && s.tracks.every((t) => t.finished || t.state !== "active");
const log: unknown[] = [];
await timed("queue running to the end", async () => {
  for (;;) {
    const s = await status();
    log.push({ ms: Date.now() - started, tracks: s.tracks.length, done: sum(s), waiting: s.waiting });
    if (done(s) || left() < 60_000) break;
    await sleep(5000);
  }
});
record("progress", log);
const last = await status();
if (!done(last)) await page.click("[data-track-pause]").catch(() => say("no pause button"));
await sleep(2500);
await snap("end");
record("end", {
  finished: done(last),
  tracks: last.tracks.length,
  done: sum(last),
  total: last.tracks.reduce((a, t) => a + t.total, 0),
  parked: last.tracks.filter((t) => t.parked).length,
  skipped: last.tracks.reduce((a, t) => a + t.skipped, 0),
  failed: last.tracks.filter((t) => t.state === "failed").map((t) => [t.id, t.failure]),
  summary: await page.locator(".track-summary").innerText(),
  proposals: await page.evaluate(() =>
    window.eyespy!.track.proposals().then((p) => ({
      left_out: p.left_out.length,
      weak: p.weak_covers,
      overlaps: p.groups.flatMap((g) => g.tracks).filter((t) => t.converged_with.length).length,
      groups: p.groups.length,
    })),
  ),
});
// the Videos panel's report
await page.locator("#panel-videos > summary").click();
await sleep(1500);
await page.locator("#panel-videos").scrollIntoViewIfNeeded();
await snap("videos-storage");
record("clipRowText", await page.locator("[data-clip-tracking-bytes]").allInnerTexts());
record("storage", await storage());
record("modelRequests", [...new Set(requests.filter((r) => r.startsWith("/models/")))]);
await page.locator("#panel-videos > summary").click();
// a look at the last frames with everything drawn
for (const f of [0.1, 0.35, 0.6, 0.85]) {
  const at = Math.floor(f * (n - 1));
  await scrubTo(at);
  await sleep(1200);
  await snap(`scrub-${at}`);
}
await finish();
