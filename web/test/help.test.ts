import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIG_KEYS } from "eyespy-core/session/pure";
import { EXAMPLES } from "../src/state/examples.ts";
import { createLayersStore } from "../src/state/layers.ts";
import { createSettingsStore } from "../src/state/settings.ts";
import { PRODUCTION_MODELS, PRODUCTION_RUNTIME } from "../src/engine/manifest.ts";
import { fmtBytes } from "../src/ui/common.tsx";
import type { Help } from "../src/ui/help.ts";
import {
  HELP,
  LAYER_HELP,
  PANEL_HELP,
  PREFERENCE_HELP,
  TOOL_HELP,
  GPU_NOTE,
  NO_WEBGPU_TEXT,
  stepsFor,
  SAM_LICENCE_TEXT,
  UNSUPPORTED_VIDEO,
  DOWNLOAD_GB,
  budgetLabel,
  keyframesInMB,
  reencodeTime,
  settingHelp,
} from "../src/ui/help.ts";
import { PANELS } from "../src/ui/panels/index.ts";
import { TOOLS } from "../src/ui/stage/tools.ts";

/** Settings-store fields that are state, not settings. */
const NOT_SETTINGS = new Set(["open", "persisted"]);

function wellFormed(where: string, h: Help | undefined) {
  assert.ok(h, `${where}: no help text`);
  assert.ok(h.label.trim().length > 1 && h.label.length <= 40, `${where}: label`);
  assert.ok(h.tip.trim().length >= 30, `${where}: tip too short`);
  assert.ok(h.tip.length <= 400, `${where}: tip is ${h.tip.length} chars (keep it to a sentence or two)`);
  assert.ok(/[.)]$/.test(h.tip), `${where}: tip ends a sentence`);
  if (h.more) assert.ok(h.more.length <= 700 && /[.)]$/.test(h.more), `${where}: more`);
}

test("every browser preference in the settings store has help", () => {
  const keys = Object.keys(createSettingsStore({ get: () => null, set: () => {} }, { get: () => null }).getState());
  const settings = keys.filter((k) => !NOT_SETTINGS.has(k));
  assert.ok(settings.length >= 3);
  for (const k of settings) wellFormed(`preference ${k}`, (PREFERENCE_HELP as Record<string, Help>)[k]);
});

test("every session setting has help (core CONFIG_META), with the CLI's line as the detail", () => {
  for (const k of CONFIG_KEYS) {
    const h = settingHelp(k);
    wellFormed(`setting ${k}`, h);
    assert.match(h.more ?? "", new RegExp(`eyespy config ${k}`));
  }
});

test("every tool, layer and panel has help", () => {
  for (const t of TOOLS) {
    wellFormed(`tool ${t.id}`, t.help);
    assert.equal(t.help, TOOL_HELP[t.id]);
  }
  assert.deepEqual(Object.keys(TOOL_HELP).toSorted(), TOOLS.map((t) => t.id).toSorted());
  for (const id of Object.keys(createLayersStore().getState().layers))
    wellFormed(`layer ${id}`, (LAYER_HELP as Record<string, Help>)[id]);
  for (const p of PANELS) wellFormed(`panel ${p.id}`, PANEL_HELP[p.id]);
  assert.deepEqual(Object.keys(PANEL_HELP).toSorted(), PANELS.map((p) => p.id).toSorted());
  for (const [k, h] of Object.entries(HELP)) wellFormed(`HELP.${k}`, h);
});

test("can't-decode dialog: which file, what it is, that it can't be added here; nothing else", () => {
  assert.equal(
    UNSUPPORTED_VIDEO.why("IMG_1.MOV", "HEVC/H.265"),
    "IMG_1.MOV is HEVC/H.265 video, which this browser can't decode, so it can't be added here.",
  );
  assert.equal(
    UNSUPPORTED_VIDEO.why("a.mkv", "unknown"),
    "a.mkv is in a format which this browser can't decode, so it can't be added here.",
  );
  assert.deepEqual(Object.keys(UNSUPPORTED_VIDEO).toSorted(), ["title", "why"]);
});

test("re-encode estimates: seconds, then minutes; cache sizes in keyframes", () => {
  assert.equal(reencodeTime(0), "nothing");
  assert.equal(reencodeTime(3), "about 3–6 s");
  assert.equal(reencodeTime(54), "about 1–2 min");
  assert.equal(reencodeTime(600), "about 10–20 min");
  assert.equal(keyframesInMB(2048), 38);
  assert.equal(keyframesInMB(10), 2, "at least 2, as the engine sizes it");
});

test("sizes keep the number and its unit together (no line break inside 2.80 GB)", () => {
  assert.equal(budgetLabel(4096), "4 GB");
  assert.equal(budgetLabel(null), "unlimited");
  assert.equal(fmtBytes(3 * 2 ** 30), "3.00 GB");
  assert.equal(fmtBytes(638 * 2 ** 20), "638 MB");
  assert.equal(fmtBytes(464 * 2 ** 10), "464 KB");
});

test("SAM License dialog: short, says what and why, links the full text, the two answers", () => {
  const T = SAM_LICENCE_TEXT;
  const body = T.intro;
  assert.ok(body.length <= 400, `dialog text is ${body.length} chars (keep it curt)`);
  for (const must of ["open source", "Apache-2.0", "SAM 3", "1.8 GB", "SAM License", "not an open-source"])
    assert.ok(T.intro.includes(must), `intro mentions ${must}`);
  assert.match(T.links.between, /DINOv2.*Apache-2\.0/, "DINOv2 only in the notices line");
  assert.ok(!body.includes("DINOv2"), "DINOv2 needs no agreement");
  assert.equal(T.agree, "I agree");
  assert.equal(T.cancel, "Cancel");
  for (const s of [T.intro, T.banner]) assert.match(s, /\.$/);
  assert.ok(T.banner.length <= 200 && T.banner.includes("SAM License"));
});

test("no-WebGPU page: both cases name WebGPU and the GPU, say what to do, in full sentences", () => {
  const T = NO_WEBGPU_TEXT;
  assert.match(T.how, /WebGPU/);
  assert.match(T.how, /graphics card \(GPU\)/);
  for (const kind of ["no-webgpu", "no-adapter"] as const) {
    assert.ok(T.title[kind].length <= 60, `${kind}: title`);
    for (const s of [T.why[kind], T.todo[kind]]) assert.match(s, /\.$/, `${kind}: ${s}`);
  }
  assert.notEqual(T.why["no-webgpu"], T.why["no-adapter"]);
  const all = JSON.stringify(T);
  assert.ok(!all.includes("—"), "no em-dash asides");
  for (const g of Object.values(T.guides))
    for (const s of g.steps) {
      assert.match(s.text, /[.]$/, s.text);
      assert.equal(s.text.split("`").length % 2, 1, `balanced backticks: ${s.text}`);
      assert.ok(s.text.length <= 260, `short step: ${s.text}`);
    }
  assert.match(GPU_NOTE, /desktop or laptop/);
});

test("stepsFor: this OS and case first, then general steps; other systems' only when the OS is unknown", () => {
  const steps = [
    { os: ["windows"], kind: "no-webgpu", text: "win" },
    { text: "any" },
    { os: ["linux"], kind: "no-webgpu", text: "linux" },
    { kind: "no-adapter", text: "accel" },
  ] as const;
  const order = (os: Parameters<typeof stepsFor>[1], kind: "no-webgpu" | "no-adapter") =>
    stepsFor(steps, os, kind).map((s) => s.text);
  assert.deepEqual(order("linux", "no-webgpu"), ["linux", "any", "accel"]);
  assert.deepEqual(order("linux", "no-adapter"), ["any", "accel", "linux"]);
  assert.deepEqual(order(null, "no-webgpu"), ["win", "linux", "any", "accel"]);
});

test("DOWNLOAD_GB matches the default first download (every model but the fp16 detector, plus the ORT wasm)", () => {
  const models = Object.entries(PRODUCTION_MODELS).filter(([name]) => name !== "detector_fp16_nosign.onnx");
  const bytes = models.reduce((n, [, e]) => n + e.bytes, PRODUCTION_RUNTIME.ortWasm.bytes);
  assert.equal((bytes / 1e9).toFixed(1), DOWNLOAD_GB);
});

test("examples: every clip the app offers is in web/public/examples, with its source in SOURCES.txt", () => {
  const dir = new URL("../public/examples/", import.meta.url);
  const sources = readFileSync(new URL("SOURCES.txt", dir), "utf8");
  for (const e of EXAMPLES) {
    assert.ok(existsSync(new URL(e.file, dir)), e.file);
    assert.match(
      sources,
      new RegExp(`^${e.file.replace(".", "\\.")}\\n  From: .+\\n  https://.+\\n  By: .+\\n  Licence: `, "m"),
    );
  }
});
