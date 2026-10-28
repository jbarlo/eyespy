/**
 * Drives the built debug page. It adds a video, runs find on some frames, and prints timings and results.
 *   node --import tsx scripts/smoke.ts <video> [prompt] [frames] [--session name] [--profile dir] [--detector fp16]
 *     [--out find.jpg]
 */
import { parseArgs } from "node:util";
import { launch, pageMounts, serve } from "./harness.ts";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    profile: { type: "string" },
    detector: { type: "string" },
    out: { type: "string" },
  },
});
const [video, prompt = "jar", frames = "0-3"] = positionals;
if (!video) throw new Error("usage: smoke.ts <video> [prompt] [frames]");

const srv = await serve(pageMounts());
const { page, close } = await launch({ userDataDir: o.profile });
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("dialog", (d) => {
  console.log("[dialog]", d.message(), "-> dismissed");
  void d.dismiss();
});
const session = o.session ?? `smoke-${Date.now()}`;
const t0 = Date.now();
await page.goto(
  `${srv.url}/?debug&models=/models&runtime=/nm&session=${session}${o.detector ? `&detector=${o.detector}` : ""}`,
);
await page.evaluate(() => window.eyespyReady!.then(() => true));
console.log(`engine ready in ${Date.now() - t0} ms`);
const lap = async <T>(name: string, f: () => Promise<T>) => {
  const t = Date.now();
  const r = await f();
  console.log(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return r;
};
const st = await page.evaluate(() => window.eyespy!.status());
if (!st.clips.length) {
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.type = "file";
    i.id = "testvideo";
    document.body.append(i);
  });
  await page.setInputFiles("#testvideo", video);
  const add = await lap("add", () =>
    page.evaluate(() => {
      const file = (document.getElementById("testvideo") as HTMLInputElement).files?.[0];
      if (!file) throw new Error("no file in #testvideo");
      return window.eyespy!.addFile(file);
    }),
  );
  console.log("add:", JSON.stringify(add));
}
const find = await lap(`find ${prompt} -f ${frames}`, () =>
  page.evaluate(([p, f]) => window.eyespy!.find({ prompt: p, frames: f }), [prompt, frames] as const),
);
console.log("find:", JSON.stringify({ ...find, hits: find.hits.length, image: !!find.image }));
const events = await page.evaluate(() =>
  window.eyespyEvents
    .filter((e) => e.kind !== "log" || /loaded|encoded|added|error|fail/i.test(e.text))
    .map((e) => (e.kind === "log" ? e.text : JSON.stringify(e))),
);
console.log(events.filter((e) => !e.includes('"kind":"download"') || e.includes('"done":true')).join("\n"));
if (o.out) {
  if (!find.image) throw new Error("find returned no image to save");
  const fs = await import("node:fs");
  const b64 = await page.evaluate(async (u) => {
    const b = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  }, find.image);
  fs.writeFileSync(o.out, Buffer.from(b64, "base64"));
}
await close();
srv.close();
