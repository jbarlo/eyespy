/**
 * Shared by the browser scripts: a static server for the built page and local models, a Chromium with WebGPU on the
 * real GPU (headless works through Vulkan), and the page driver for the UI scripts.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Inputs, OpPath, Outputs } from "eyespy-core/api";
import { MODELS, scratch } from "../../server/scripts/validate/paths.ts";
import { LICENCE_PREF } from "../src/state/licence.ts";
import { samLicenseSha256 } from "./notices.ts";

export { scratch } from "../../server/scripts/validate/paths.ts";
export const WEB = path.resolve(import.meta.dirname, "..");

/**
 * An H.264 MP4 copy of `video`, made once with the devshell's ffmpeg. The web app decodes only natively, and a
 * Chromium without an HEVC decoder can't read HEVC video.
 */
export function h264Copy(video: string): string {
  const out = scratch(`h264/${path.basename(video).replace(/\.[^.]*$/, "")}.mp4`);
  if (existsSync(out)) return out;
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp.mp4`;
  const args = ["-v", "error", "-y", "-i", video, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", tmp];
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  renameSync(tmp, out);
  return out;
}

/** The value, or a thrown error naming what was expected (for results a script relies on being there). */
export function must<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`expected ${what}`);
  return v;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
};

/**
 * Serves `mounts` (each URL prefix maps to a directory or file) on localhost, with Range support. A fixed port
 * (EYESPY_WEB_PORT) keeps the origin across runs, and with it a persistent profile's OPFS model cache.
 */
export function serve(
  mounts: Record<string, string>,
  port = Number(process.env.EYESPY_WEB_PORT ?? 0),
): Promise<{ url: string; close: () => void; bytes: () => number }> {
  let sent = 0;
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    let file: string | null = null;
    for (const [pre, target] of Object.entries(mounts).sort((a, b) => b[0].length - a[0].length))
      if (u === pre || u.startsWith(pre.endsWith("/") ? pre : pre + "/")) {
        file = statSync(target).isDirectory() ? path.join(target, u.slice(pre.length)) : target;
        break;
      }
    if (!file || !existsSync(file) || statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const size = statSync(file).size;
    const h = {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const [a, b] = m ? [m[1] ? +m[1] : 0, m[2] ? +m[2] : size - 1] : [0, size - 1];
    res.writeHead(m ? 206 : 200, {
      ...h,
      "Content-Length": b - a + 1,
      ...(m ? { "Content-Range": `bytes ${a}-${b}/${size}` } : {}),
    });
    sent += b - a + 1;
    createReadStream(file, { start: a, end: b }).pipe(res);
  });
  return new Promise((res) =>
    srv.listen(port, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      res({ url: `http://localhost:${port}`, close: () => srv.close(), bytes: () => sent });
    }),
  );
}

/**
 * Flags that give headless Chromium a WebGPU adapter on the GPU. Without --use-angle=vulkan, headless stays on
 * SwiftShader.
 */
const GPU_FLAGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=native",
  "--use-angle=vulkan",
  "--ignore-gpu-blocklist",
];

/** tsx (esbuild keepNames) wraps named functions in __name(); define it in pages so page.evaluate callbacks run. */
const KEEP_NAMES_SHIM = "globalThis.__name = (f) => f;";

/**
 * Agrees to the SAM License this checkout builds before every page load, so scripts never stop at the licence dialog.
 * Storage throws on blank pages, and the script ignores that.
 */
const agreeToSam = (record: { key: string; value: string }) => {
  try {
    localStorage.setItem(record.key, record.value);
  } catch {}
};
const samAgreement = () => ({
  key: `eyespy.${LICENCE_PREF}`,
  value: JSON.stringify({ sha256: samLicenseSha256(), at: new Date().toISOString() }),
});

/** `agreeSam: false` leaves the licence agreement alone (a fresh profile then gets the licence dialog). */
export async function launch(
  opts: { userDataDir?: string; agreeSam?: boolean } = {},
): Promise<{ browser: Browser | null; page: Page; close: () => Promise<void> }> {
  const executablePath = process.env.CHROMIUM ?? "chromium";
  const headless = process.env.HEADLESS !== "0";
  const agree = opts.agreeSam ?? true;
  if (opts.userDataDir) {
    // a persistent profile keeps OPFS, and so the model cache, between runs
    const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
      executablePath: resolveBin(executablePath),
      headless,
      args: GPU_FLAGS,
    });
    await ctx.addInitScript(KEEP_NAMES_SHIM);
    if (agree) await ctx.addInitScript(agreeToSam, samAgreement());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return { browser: null, page, close: () => ctx.close() };
  }
  const browser = await chromium.launch({ executablePath: resolveBin(executablePath), headless, args: GPU_FLAGS });
  const page = await browser.newPage();
  await page.addInitScript(KEEP_NAMES_SHIM);
  if (agree) await page.addInitScript(agreeToSam, samAgreement());
  return { browser, page, close: () => browser.close() };
}

function resolveBin(name: string) {
  if (name.includes("/")) return name;
  for (const d of (process.env.PATH ?? "").split(":")) if (existsSync(path.join(d, name))) return path.join(d, name);
  throw new Error(`${name} not found on PATH (set CHROMIUM)`);
}

/** Mounts for the built page: dist, models, node_modules for ort. */
export function pageMounts(extra: Record<string, string> = {}) {
  return {
    "/": path.join(WEB, "dist", "index.html"),
    "/models": MODELS,
    "/nm": path.join(WEB, "node_modules"),
    ...extra,
  };
}

type Caption = { file: string; caption: string };
/** Console errors that are ORT or mp4box noise, not app problems. */
const NOISE = /onnxruntime|VerifyEachNode|constant_folding|BoxParser/;

/**
 * Page driver. It takes numbered screenshots with captions (`resume` continues `<out>/captions.json`), prints timed
 * step lines, reads UI state, sends typed router ops, and collects page errors for `finish`.
 */
export function driver(page: Page, out: string, opts: { resume?: boolean } = {}) {
  const capPath = path.join(out, "captions.json");
  const captions: Caption[] =
    opts.resume && existsSync(capPath) ? (JSON.parse(readFileSync(capPath, "utf8")) as Caption[]) : [];
  let shot = captions.reduce((a, c) => Math.max(a, Number.parseInt(c.file, 10) || 0), 0);
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !NOISE.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;
  return {
    captions,
    problems,
    elapsed,
    snap: async (name: string, caption: string, p: Page = page) => {
      const file = `${String(++shot).padStart(2, "0")}-${name}.png`;
      await p.screenshot({ path: path.join(out, file) });
      captions.push({ file, caption });
      console.log(`  [${file}] ${caption}`);
    },
    step: (s: string) => console.log(`${elapsed().toFixed(0).padStart(4)}s  ${s}`),
    state: () => page.evaluate(() => window.eyespyUI.state()),
    /** Waits until no engine action runs, polling every `polling` ms or every animation frame. */
    idle: (timeout = 600_000, polling: number | "raf" = "raf") =>
      page.waitForFunction(() => window.eyespyUI && !window.eyespyUI.state().busy, null, { timeout, polling }),
    /** Sends one router op through window.eyespy. Store references in the output come back as object URLs. */
    api: <P extends OpPath>(op: P, input?: Inputs[P]) =>
      page.evaluate(([op, input]) => window.eyespy!.call(op, input), [op, input] as const) as Promise<Outputs[P]>,
    /** Writes captions.json and reports page problems, with exit code 1 when there were any. */
    finish: () => {
      writeFileSync(capPath, JSON.stringify(captions, null, 1) + "\n");
      if (!problems.length) return;
      console.log(`page problems:\n${problems.join("\n")}`);
      process.exitCode = 1;
    },
  };
}
