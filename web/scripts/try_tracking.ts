/**
 * Opens the built app with video tracking in a visible Chromium on the real GPU, for trying it by hand. Tracker graphs
 * come from EYESPY_MODELS. The browser profile and its port stay the same between runs, so sessions and the model cache
 * are still there next time. Closing the window ends it.
 *
 *   EYESPY_MODELS=scratch/models-tracker node --import tsx scripts/try_tracking.ts [--profile dir] [--session name]
 *
 * It needs `vite build` first.
 */
import { parseArgs } from "node:util";
import { launch, pageMounts, scratch, serve } from "./harness.ts";

const { values: o } = parseArgs({ options: { profile: { type: "string" }, session: { type: "string" } } });
process.env.HEADLESS = "0";
const srv = await serve(pageMounts(), Number(process.env.EYESPY_WEB_PORT ?? 41906));
const { page, close } = await launch({ userDataDir: o.profile ?? scratch("try-tracking/profile"), agreeSam: false });
const url = `${srv.url}/?models=/models&runtime=/nm&detector=fp16&tracker${o.session ? `&session=${o.session}` : ""}`;
console.log(`open at ${url}`);
await page.goto(url);
await new Promise<void>((done) => page.on("close", () => done()));
await close().catch(() => undefined);
srv.close();
