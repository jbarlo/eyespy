/**
 * Checks store layout compatibility. It copies a CLI session's .eyespy/ (minus the feature cache, socket and
 * log) into an OPFS session, opens it in the browser engine, and checks that it sees the same keyframes, detections and
 * cached runs.
 *   node --import tsx scripts/import_node.ts <node session dir> [prompt] [frames]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { launch, pageMounts, serve } from "./harness.ts";

const [dir, prompt = "jar", frames = "0-3"] = process.argv.slice(2);
if (!dir) throw new Error("usage: import_node.ts <node session dir> [prompt] [frames]");
const base = path.join(dir, ".eyespy");
const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(path.join(base, d))) {
    const rel = d ? `${d}/${e}` : e;
    if (/(^|\/)feat$|^sock$|\.log$|\.tmp$/.test(rel)) continue;
    if (statSync(path.join(base, rel)).isDirectory()) walk(rel);
    else files.push(rel);
  }
};
walk("");
const srv = await serve(pageMounts({ "/nodesession": base }));
const { page, close } = await launch();
const name = `imported-${Date.now()}`;
await page.goto(`${srv.url}/?debug&models=/models&runtime=/nm&session=${name}`);
await page.evaluate(() => window.eyespyReady!.then(() => true));
const t = Date.now();
await page.evaluate(
  async ([name, files]) => {
    const root = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions")
    ).getDirectoryHandle(name);
    for (const f of files) {
      let d = await root.getDirectoryHandle(".eyespy", { create: true });
      const parts = f.split("/");
      const leaf = parts.pop() ?? f;
      for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle(leaf, { create: true })).createWritable();
      await w.write(await (await fetch(`/nodesession/${f}`)).arrayBuffer());
      await w.close();
    }
  },
  [name, files] as const,
);
console.log(`copied ${files.length} files in ${Date.now() - t} ms`);
await page.goto(`${srv.url}/?debug&models=/models&runtime=/nm&session=${name}`);
await page.evaluate(() => window.eyespyReady!.then(() => true));
const r = await page.evaluate(
  async ([p, f]) => {
    const v = window.eyespy!;
    const t = performance.now();
    const find = await v.find({ prompt: p, frames: f });
    return {
      status: await v.status(),
      findMs: Math.round(performance.now() - t),
      hits: find.hits.map((h: { id: string; score: number }) => `${h.id}@${h.score}`),
      image: !!find.image,
    };
  },
  [prompt, frames] as const,
);
const nodeDets = JSON.parse(readFileSync(path.join(base, "dets.json"), "utf8")) as {
  id: string;
  frame: number;
  prompt: string;
  score: number;
}[];
const want = nodeDets
  .filter((d) => d.prompt === prompt && d.score >= 0.5 && d.frame <= Number(frames.split("-").pop()))
  .map((d) => `${d.id}@${d.score}`);
const same = JSON.stringify([...want].sort()) === JSON.stringify([...r.hits].sort());
console.log(
  JSON.stringify(
    { status: r.status, findMs: r.findMs, hits: r.hits.length, nodeHits: want.length, identical: same, image: r.image },
    null,
    1,
  ),
);
await close();
srv.close();
process.exit(same ? 0 : 1);
