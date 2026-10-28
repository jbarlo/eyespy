/**
 * Checks whether a browser other than Chromium gets a WebGPU adapter here. Launches Playwright's Firefox and WebKit
 * (from nixpkgs' playwright-driver.browsers; pass its store path) on the built page and asks navigator.gpu.
 *   node --import tsx scripts/browsers.ts /nix/store/...-playwright-browsers
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { firefox, webkit, type BrowserType } from "playwright-core";
import { pageMounts, serve } from "./harness.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: browsers.ts <playwright-browsers dir>");
const find = (prefix: string) => readdirSync(dir).find((n) => n.startsWith(prefix));
const srv = await serve(pageMounts());

async function probe(name: string, type: BrowserType, exe: string, opts: object = {}) {
  const t = Date.now();
  try {
    const b = await type.launch({ executablePath: exe, headless: true, timeout: 60_000, ...opts });
    const p = await b.newPage();
    await p.goto(`${srv.url}/?debug`, { timeout: 60_000 }).catch(() => {});
    const r = await p.evaluate(async () => {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu) return { gpu: false, adapter: null, ua: navigator.userAgent };
      const a = (await gpu.requestAdapter().catch((e: Error) => String(e))) as
        { info?: { vendor?: string; architecture?: string; description?: string } } | string | null;
      const info = a && typeof a === "object" ? (a.info ?? {}) : a;
      return {
        gpu: true,
        adapter: a ? info : null,
        ua: navigator.userAgent,
        opfs: !!navigator.storage?.getDirectory,
        codecs: typeof VideoDecoder !== "undefined",
      };
    });
    console.log(name, JSON.stringify(r), `${Date.now() - t} ms`);
    await b.close();
  } catch (e) {
    console.log(name, "launch failed:", (e as Error).message.split("\n").slice(0, 3).join(" | "));
  }
}

const ff = find("firefox-");
if (ff)
  await probe("firefox", firefox, path.join(dir, ff, "firefox", "firefox"), {
    firefoxUserPrefs: {
      "dom.webgpu.enabled": true,
      "gfx.webgpu.ignore-blocklist": true,
      "dom.webgpu.workers.enabled": true,
    },
  });
const wk = find("webkit-");
if (wk) await probe("webkit", webkit, path.join(dir, wk, "pw_run.sh"));
srv.close();
