/**
 * Screenshots of UI details that need a prepared profile. Two phases on one persistent profile:
 *   setup: session rv-small (--hevc refused with the can't-decode dialog, then --h264) and rv-big (an H.264 copy of
 *          --video, then --h264, all encoded and stored); screenshots into <out>/setup
 *   shots: desktop and phone sizes, light and dark, into <out>, with captions.json and checks-shots.json
 * Run from web/ (shots needs only --h264, for its name):
 *   node --import tsx scripts/review.ts setup|shots --out dir --profile dir --h264 C [--hevc H --video V]
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { driver, h264Copy, launch, pageMounts, serve } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    profile: { type: "string" },
    h264: { type: "string" },
    hevc: { type: "string" },
    video: { type: "string" },
  },
});
const phase = positionals[0];
if ((phase !== "setup" && phase !== "shots") || !o.out || !o.h264 || (phase === "setup" && (!o.hevc || !o.video))) {
  console.error("usage: review.ts setup|shots --out dir --profile dir --h264 C [--hevc H --video V] (setup needs all)");
  process.exit(2);
}
const OUT = phase === "setup" ? path.join(o.out, "setup") : o.out;
const H264 = o.h264;
const H264_NAME = path.basename(H264);
mkdirSync(OUT, { recursive: true });

const srv = await serve(pageMounts());
const { page, close } = await launch({ userDataDir: o.profile });
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
await page.setViewportSize(DESK);
await page.emulateMedia({ colorScheme: "light" });
const d = driver(page, OUT);
const { snap, step, state, idle, api } = d;
const base = `${srv.url}/?models=/models&runtime=/nm`;
const checks: Record<string, unknown> = {};
const SETTINGS = 'dialog[aria-label="Settings"][open]';

async function openSession(name: string) {
  await page.goto(`${base}&session=${name}`);
  await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 180_000 });
}
async function encodedAll() {
  for (let k = 0; ; k++) {
    const st = await api("status");
    if (st.encoded >= st.keyframes) return st;
    if (k > 600) throw new Error(`encode stuck ${st.encoded}/${st.keyframes}`);
    await page.waitForTimeout(2000);
  }
}
const UNSUPPORTED = "dialog[open] .unsupported-video";
/**
 * Adds a video. One this browser can't decode stops at the can't-decode dialog, which gets a screenshot and is closed,
 * and resolves false.
 */
async function addVideo(sel: string, file: string, shot?: [string, string]): Promise<boolean> {
  const n = (await state()).frames;
  await page.setInputFiles(sel, file);
  await page.waitForFunction(
    ([n, q]) => window.eyespyUI.state().frames > n || !!document.querySelector(q),
    [n, UNSUPPORTED] as const,
    { timeout: 300_000 },
  );
  if (await page.$(UNSUPPORTED)) {
    if (shot) await snap(...shot);
    await page.click("dialog[open] button.primary");
    return false;
  }
  await idle(1_200_000);
  return true;
}

/** Shows an element's native title as a tooltip box, because headless can't capture the OS tooltip window. */
async function fakeTip(sel: string) {
  await page.hover(sel);
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const t = el.closest("[title]")?.getAttribute("title") ?? "";
    const r = el.getBoundingClientRect();
    const tip = document.createElement("div");
    tip.id = "fake-tip";
    tip.textContent = t;
    Object.assign(tip.style, {
      position: "fixed",
      zIndex: "99999",
      maxWidth: "420px",
      whiteSpace: "pre-wrap",
      font: "12px system-ui",
      background: "#ffffe1",
      color: "#000",
      border: "1px solid #767676",
      padding: "3px 6px",
      boxShadow: "1px 1px 3px #0005",
    });
    document.body.append(tip);
    const h = tip.offsetHeight;
    const top = r.bottom + 18 + h > innerHeight ? r.top - h - 6 : r.bottom + 18;
    tip.style.top = `${top}px`;
    tip.style.left = `${Math.max(4, Math.min(r.left + 8, innerWidth - tip.offsetWidth - 4))}px`;
    return t;
  }, sel);
}
const unTip = () => page.evaluate(() => document.getElementById("fake-tip")?.remove());

/** The open popover's box and whether it fits the viewport. */
async function popBox() {
  return page.evaluate(() => {
    const p = document.querySelector<HTMLElement>(".info-pop:popover-open");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return {
      label: p.getAttribute("aria-label"),
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    };
  });
}
/** Opens an Info popover, clicks inside it, and checks that its parent <details> or label checkbox didn't toggle. */
async function infoPop(btn: string, name: string, caption: string) {
  const parents = () =>
    page.evaluate((btn) => {
      const b = document.querySelector(btn);
      return [
        (b?.closest("details") as HTMLDetailsElement | null)?.open ?? null,
        (b?.closest("label, .opt")?.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.checked ?? null,
      ];
    }, btn);
  const before = await parents();
  await page.locator(btn).scrollIntoViewIfNeeded();
  await page.click(btn);
  await page.waitForSelector(".info-pop:popover-open");
  const afterBtn = await parents();
  await page.locator(".info-pop:popover-open p").first().click();
  const afterInside = await parents();
  // its async toggle event places it, so measure once that has run
  const box = await popBox();
  // its paragraphs keep their spacing wherever it sits in the DOM
  const gap = await page.evaluate(() => {
    const p = document.querySelectorAll(".info-pop:popover-open p")[1];
    return p ? getComputedStyle(p).marginTop : "6px";
  });
  assert.equal(gap, "6px", `${name}: popover paragraph spacing`);
  const stillOpen = !!(await page.$(".info-pop:popover-open"));
  await snap(name, caption);
  checks[name] = { before, afterBtn, afterInside, stillOpen, box };
  assert.deepEqual(afterBtn, before, `${name}: the info button toggled its parent`);
  assert.deepEqual(afterInside, before, `${name}: a click inside the popover toggled its parent`);
  assert.ok(box?.inside, `${name}: popover outside the viewport ${JSON.stringify(box)}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".info-pop:popover-open"));
}
/** Elements sticking out of `sel` or the viewport on the right (horizontal overflow). */
async function overflowX(sel: string) {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const root = document.querySelector(sel);
    if (!root) return ["(missing)"];
    const rr = root.getBoundingClientRect();
    if (root.scrollWidth > root.clientWidth + 1)
      out.push(`${sel} scrollWidth ${root.scrollWidth} > ${root.clientWidth}`);
    for (const el of root.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (el.closest(".info-pop")) continue;
      if (r.width && (r.right > rr.right + 1 || r.right > innerWidth + 1))
        out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} right ${Math.round(r.right)}`);
    }
    return out.slice(0, 10);
  }, sel);
}
const openSettings = async () => {
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector(`${SETTINGS} .usage`);
  await page.waitForTimeout(400);
  const top = await page.evaluate((s) => document.querySelector(s)!.scrollTop, SETTINGS);
  const focus = await page.evaluate(() => document.activeElement?.className ?? "");
  ((checks.settingsOpen ??= []) as unknown[]).push({ top, focus });
  assert.equal(top, 0, "Settings opens at its top");
};
const closeSettings = () => page.click(`${SETTINGS} .actions button:has-text("Close")`);
const expandSessionSettings = async () => {
  if (await page.$(`${SETTINGS} details[open]`)) return;
  await page.locator(`${SETTINGS} details > summary`).click({ position: { x: 20, y: 8 } });
  await page.waitForSelector(`${SETTINGS} details[open] .cfg`);
};
const scrollDialog = (where: string) =>
  page.evaluate(
    ([sel, where]) => {
      const dlg = document.querySelector(sel!) as HTMLElement;
      if (where === "top") dlg.scrollTop = 0;
      else if (where === "bottom") dlg.scrollTop = dlg.scrollHeight;
      else [...dlg.querySelectorAll("h4")].find((h) => h.textContent === where)?.scrollIntoView({ block: "start" });
    },
    [SETTINGS, where],
  );
const openVideos = async () => {
  if (!(await page.$("#panel-videos[open]")))
    await page.click("#panel-videos > summary", { position: { x: 10, y: 8 } });
  await page.waitForSelector("#panel-videos li.video");
  await page.evaluate(() => document.getElementById("panel-videos")?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(600);
};
const switchTo = async (name: string) => {
  await page.click(".menu > summary");
  await page.click(`.menu-item[data-session="${name}"]`);
  await page.waitForFunction(
    (name) =>
      window.eyespyUI.state().engine === "ready" &&
      window.eyespyUI.state().session === name &&
      window.eyespyUI.state().frames > 0,
    name,
    { timeout: 180_000 },
  );
  await idle();
};

if (phase === "setup") {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("eyespy-test")) return;
    sessionStorage.setItem("eyespy-test", "1");
    localStorage.setItem("eyespy.persistFeatures", "1");
  });
  const hevc = o.hevc!;
  const video = o.video!;
  step(`rv-small: new session from ${path.basename(hevc)}`);
  await openSession("rv-small");
  const decoded = await addVideo("#empty-video", hevc, [
    "unsupported",
    `Can't-decode dialog for an HEVC clip (${path.basename(hevc)}): why, H.264 MP4, HandBrake and the iPhone setting.`,
  ]);
  if (!decoded) assert.ok(await addVideo("#empty-video", H264), `${H264_NAME} decodes`);
  await page.fill("#prompt-input", "jar");
  await page.click("form.promptbar button[type=submit]");
  await idle();
  step(`rv-small: ${JSON.stringify(await api("features"))}`);
  step(`rv-big: ${path.basename(video)} + ${H264_NAME}`);
  await openSession("rv-big");
  assert.ok(await addVideo("#empty-video", h264Copy(video)), "the H.264 copy decodes");
  step(`rv-big: ${(await state()).frames} keyframes after ${path.basename(video)}`);
  await openVideos();
  assert.ok(await addVideo("#videos-add", H264), `${H264_NAME} decodes`);
  step(`rv-big: ${(await state()).frames} keyframes; waiting for encodes`);
  await encodedAll();
  await page.waitForTimeout(3000);
  step(`rv-big: ${JSON.stringify(await api("features"))}`);
} else {
  step("open rv-big");
  await openSession("rv-big");
  await idle();
  let f = await api("features");
  step(`features ${JSON.stringify(f)}`);
  if (f.stored < f.keyframes) {
    step("re-encoding evicted keyframes (find on all frames)");
    await page.fill("#prompt-input", "jar");
    await page.click("form.promptbar button[type=submit]");
    await idle(1_200_000);
    f = await api("features");
    step(`features ${JSON.stringify(f)}`);
  }
  await page.waitForTimeout(1500);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openSettings();
    await snap(
      `settings-${scheme}`,
      `Settings (${scheme}), top: site storage, models cache, eviction protection with Ask again, per-session image features vs everything else with Drop features, totals row, Drop features of every session.`,
    );
    await scrollDialog("Image features");
    await snap(
      `settings-features-${scheme}`,
      `Settings (${scheme}), scrolled: keep features on disk, disk budget per session (4 GB) with this session's use, in-memory cache, detector precision.`,
    );
    await expandSessionSettings();
    await scrollDialog("bottom");
    await snap(
      `settings-session-${scheme}`,
      `Settings (${scheme}), bottom: Session settings expanded (from core CONFIG_META), each with its info button.`,
    );
    checks[`settings-overflow-${scheme}`] = await overflowX(SETTINGS);
    await closeSettings();
  }
  await page.emulateMedia({ colorScheme: "light" });

  await openSettings();
  await infoPop(
    `${SETTINGS} button[aria-label="About Disk budget per session"]`,
    "info-settings-budget",
    "Info popover in Settings (Disk budget per session): the click opens the long text under the button; a click inside keeps it open.",
  );
  await infoPop(
    `${SETTINGS} button[aria-label="About Keep image features on disk"]`,
    "info-settings-persist",
    "Info popover next to 'Keep image features on disk': clicking the ? or the popover text doesn't toggle the checkbox.",
  );
  await expandSessionSettings();
  await infoPop(
    `${SETTINGS} details > summary button.info`,
    "info-settings-summary",
    "Info popover in the Session settings summary: clicking the ? or inside doesn't collapse the section.",
  );
  await closeSettings();
  await page.evaluate(() => document.getElementById("panel-triage")?.scrollIntoView({ block: "start" }));
  await infoPop(
    "#panel-triage > summary button.info",
    "info-triage",
    "Info popover on a panel header (Triage): the panel stays open when clicking the ? and inside the popover.",
  );
  await infoPop(
    "#panel-layers .panel-body button.info",
    "info-threshold",
    "Info popover next to the Score threshold slider (Layers).",
  );
  await infoPop("form.promptbar button.info", "info-find", "Info popover in the prompt bar (Find).");

  const tool = await fakeTip(".toolbar button");
  await snap(
    "tip-tool",
    "Hover tooltip of the Select tool (native title text, drawn by the script: headless can't capture OS tooltips).",
  );
  await unTip();
  const dev = await fakeTip(".statusbar .dot + span");
  await snap("tip-device", "Hover tooltip of the status bar device (native title text, drawn by the script).");
  await unTip();
  checks.tips = { tool, dev };

  await openVideos();
  await snap(
    "videos",
    "Videos panel, two clips: per-clip keyframe images vs features stored, Drop features and Remove, the session totals against the disk budget.",
  );
  checks["videos-overflow"] = await overflowX("#panel-videos");
  await page.click(`#panel-videos button[aria-label="Drop features of ${H264_NAME}"]`);
  await page.waitForSelector('dialog[aria-label="Confirm"][open]');
  checks.dropConfirm = await page.textContent('dialog[aria-label="Confirm"][open] p');
  await snap(
    "drop-confirm",
    `Drop features confirm (Videos panel, ${H264_NAME}): size, what stays, the re-encode estimate, and that features are saved again.`,
  );
  await page.click('dialog[aria-label="Confirm"][open] button:has-text("Cancel")');
  await openSettings();
  await page.click(`${SETTINGS} button[aria-label="Drop features of rv-small"]`);
  await page.waitForSelector('dialog[aria-label="Confirm"][open]');
  checks.dropConfirmSession = await page.textContent('dialog[aria-label="Confirm"][open] p');
  await snap("drop-confirm-session", "Drop features confirm from the Settings sessions table (rv-small, not open).");
  await page.click('dialog[aria-label="Confirm"][open] button:has-text("Cancel")');
  await closeSettings();

  await page.setViewportSize(PHONE);
  await page.waitForTimeout(600);
  await openSettings();
  await snap("phone-settings", "Phone (390 px): Settings, top (storage, sessions table).");
  checks["phone-settings-overflow"] = await overflowX(SETTINGS);
  await scrollDialog("Image features");
  await snap("phone-settings-features", "Phone: Settings, image feature options.");
  await infoPop(
    `${SETTINGS} button[aria-label="About Disk budget per session"]`,
    "phone-info-budget",
    "Phone: the disk budget info popover (kept inside the viewport with a 16 px gutter).",
  );
  await expandSessionSettings();
  await scrollDialog("bottom");
  await snap("phone-settings-session", "Phone: Session settings expanded.");
  await closeSettings();
  await page.emulateMedia({ colorScheme: "dark" });
  await openSettings();
  await snap("phone-settings-dark", "Phone, dark: Settings top.");
  await closeSettings();
  await page.emulateMedia({ colorScheme: "light" });
  await openVideos();
  await snap("phone-videos", "Phone: Videos panel with two clips.");
  checks["phone-videos-overflow"] = await overflowX("#panel-videos");
  await page.evaluate(() => document.getElementById("panel-triage")?.scrollIntoView({ block: "start" }));
  await infoPop("#panel-triage > summary button.info", "phone-info-triage", "Phone: Triage header info popover.");
  await page.evaluate(() => window.scrollTo(0, 0));
  await infoPop("form.promptbar button.info", "phone-info-find", "Phone: Find info popover (prompt bar, right edge).");
  await page.setViewportSize(DESK);
  await page.waitForTimeout(600);

  // a budget below the open session's size shows the eviction status
  await openSettings();
  const before = await api("features");
  await page.selectOption('select[aria-label="Disk budget per session"]', "2048");
  await page.waitForSelector(`${SETTINGS} [data-disk-budget] [role="status"]`, { timeout: 60_000 });
  await idle();
  await page.waitForTimeout(800);
  const after = await api("features");
  checks.lower2GB = {
    before,
    after,
    status: await page.textContent(`${SETTINGS} [data-disk-budget] [role="status"]`),
  };
  await snap(
    "budget-lowered",
    "Budget lowered 4 → 2 GB with rv-big open: its row now reads against 2 GB, and the status line (below) says how many keyframes' features were deleted.",
  );
  await scrollDialog("Image features");
  await snap("budget-lowered-features", "Same, scrolled to the budget select and its status line.");
  await closeSettings();
  // with another session open, rv-big's row over a 1 GB budget shows the warning colour
  await switchTo("rv-small");
  await openSettings();
  await page.selectOption('select[aria-label="Disk budget per session"]', "1024");
  await idle();
  await page.waitForTimeout(1500);
  const warn = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('dialog[aria-label="Settings"][open] [data-session-usage] .warn-text')].map(
        (e) => ({
          row: e.closest("tr")?.getAttribute("data-session-usage"),
          text: e.textContent,
          color: getComputedStyle(e).color,
        }),
      ),
    );
  checks.warnLight = await warn();
  await snap(
    "budget-warn",
    "rv-small open, budget 1 GB: rv-big (2 GB stored; evicted only when it opens) shows its use against 1 GB in the warning colour.",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  checks.warnDark = await warn();
  await snap("budget-warn-dark", "Same, dark theme.");
  await page.emulateMedia({ colorScheme: "light" });
  await page.selectOption('select[aria-label="Disk budget per session"]', "4096");
  await idle();
  await closeSettings();
}
writeFileSync(path.join(OUT, `checks-${phase}.json`), JSON.stringify(checks, null, 1) + "\n");
d.finish();
await close();
srv.close();
console.log(`${phase} done`);
