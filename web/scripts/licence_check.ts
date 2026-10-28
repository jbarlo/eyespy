/**
 * Checks the SAM License dialog on a fresh profile. The dialog shows before the engine starts, with focus on
 * the first action. Escape cancels: a banner shows and the worker refuses SAM 3 files. Review, then I agree, stores the
 * agreement against the shipped text's sha256, and SAM 3 files load. Saves light and dark screenshots at desktop and
 * phone widths into <out>.
 * Usage: EYESPY_WEB_PORT=8803 node --import tsx scripts/licence_check.ts <out>
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, pageMounts, serve } from "./harness.ts";
import { samLicenseSha256 } from "./notices.ts";

const out = process.argv[2] ?? "licence-modal";
mkdirSync(out, { recursive: true });
const srv = await serve(pageMounts());
const profile = mkdtempSync(path.join(tmpdir(), "eyespy-licence-profile-"));
const { page, close } = await launch({ userDataDir: profile, agreeSam: false });
const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log("ok:", what);
};
try {
  const url = `${srv.url}/?models=/models&runtime=/nm&session=licence-check`;
  const shots = async (name: string) => {
    for (const scheme of ["light", "dark"] as const)
      for (const [w, h, tag] of [
        [1280, 800, "desktop"],
        [390, 844, "390"],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(out, `${name}-${scheme}-${tag}.png`) });
      }
    await page.setViewportSize({ width: 1280, height: 800 });
  };

  await page.goto(url);
  await page.waitForSelector("dialog[open] .licence", { timeout: 30_000 });
  ok(await page.evaluate(() => !window.eyespy), "dialog shown before any engine started");
  ok(
    (await page.evaluate(() => document.activeElement?.textContent)) === "Cancel",
    "focus on the first action (Cancel)",
  );
  await shots("modal");

  await page.keyboard.press("Escape");
  await page.waitForSelector(".licence-banner", { timeout: 30_000 });
  await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 60_000 });
  const refused = await page.evaluate(() =>
    window.eyespy!.prepare(["tokenizer.json"]).then(
      () => "loaded",
      (e: Error) => e.message,
    ),
  );
  ok(refused.includes("SAM License not accepted"), `after Cancel the worker refuses SAM 3 files (${refused})`);
  ok(await page.evaluate(() => localStorage.getItem("eyespy.licence.sam") === null), "nothing stored after Cancel");
  await shots("banner");

  await page.click(".licence-banner button");
  await page.waitForSelector("dialog[open] .licence");
  await page.click("dialog[open] button.primary");
  await page.waitForSelector(".licence-banner", { state: "detached" });
  await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 60_000 });
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem("eyespy.licence.sam") ?? "null"));
  ok(rec?.sha256 === samLicenseSha256(), `agreement stored for the shipped text (${JSON.stringify(rec)})`);
  const loaded = await page.evaluate(() =>
    window.eyespy!.prepare(["tokenizer.json", "detector_fp16_nosign.onnx"]).then(
      () => "loaded",
      (e: Error) => e.message,
    ),
  );
  ok(loaded === "loaded", `after I agree SAM 3 files download and load (${loaded})`);

  await page.reload();
  await page.waitForFunction(() => window.eyespyUI?.state().engine === "ready", null, { timeout: 60_000 });
  ok((await page.$("dialog[open] .licence")) === null, "a reload with the agreement asks nothing");
  await page.screenshot({ path: path.join(out, "after-agree-desktop.png") });
} finally {
  await close();
  srv.close();
}
