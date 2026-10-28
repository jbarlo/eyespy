/**
 * Vite plugin that writes the licence files a deployment must carry into dist/ on every build.
 *
 * - THIRD_PARTY_NOTICES.txt lists every npm package whose code Rollup bundled, with its own LICENSE and NOTICE files.
 *   That covers the page and the inlined worker, and leaves out tree-shaken and type-only packages. Then come the
 *   run-time components (ONNX Runtime's wasm, the models) with their texts from third_party/. A bundled package with no
 *   licence file and no entry in SUPPLEMENTS fails the build.
 * - COPIES are licence texts placed beside the files they cover.
 *
 * The app records its SAM License agreement against `samLicenseSha256()`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynotices)([.-].*)?$/i;

/** Licence texts for bundled packages whose npm tarball ships none (repo-relative files). */
const SUPPLEMENTS: Readonly<Record<string, readonly string[]>> = {
  // onnxruntime-web's bundle also contains onnxruntime-common (one source tree, github.com/microsoft/onnxruntime)
  "onnxruntime-web": ["third_party/onnxruntime/LICENSE"],
  "onnxruntime-common": ["third_party/onnxruntime/LICENSE"],
};

/** Rollup and Rolldown virtual helper modules, and the package their code comes from. */
const VIRTUAL: readonly (readonly [RegExp, string])[] = [
  [/^\0?vite\//, "vite"],
  [/^\0?rolldown\//, "rolldown"],
];

type Pkg = { name: string; version: string; license: string; dir: string; homepage?: string };

/** The package a bundled module belongs to, or null for our own sources. */
function packageOf(id: string, webDir: string): string | null {
  const clean = id.replace(/\?.*$/, "");
  const virtual = VIRTUAL.find(([re]) => re.test(clean));
  // vite is the web package's dependency, rolldown is vite's (its sibling in pnpm's layout)
  if (virtual) return path.join(realpathSync(path.join(webDir, "node_modules", "vite")), "..", virtual[1]);
  const at = clean.lastIndexOf("/node_modules/");
  if (at < 0) {
    if (clean.startsWith("\0") || !clean.startsWith(REPO))
      throw new Error(`notices: can't attribute bundled module ${JSON.stringify(id)} to a package`);
    return null;
  }
  const rest = clean.slice(at + "/node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? rest.slice(0, 2).join("/") : (rest[0] ?? "");
  return clean.slice(0, at + "/node_modules/".length) + name;
}

function readPkg(dir: string): Pkg {
  const j = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const license = typeof j.license === "string" ? j.license : "UNKNOWN";
  const homepage = typeof j.homepage === "string" ? j.homepage : undefined;
  return { name: String(j.name), version: String(j.version), license, dir, ...(homepage ? { homepage } : {}) };
}

function section(p: Pkg): string {
  const own = readdirSync(p.dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(path.join(p.dir, f), "utf8").trim());
  const texts = own.length ? own : (SUPPLEMENTS[p.name] ?? []).map((f) => read(f).trim());
  if (!texts.length)
    throw new Error(
      `notices: ${p.name}@${p.version} ships no licence file; add one to SUPPLEMENTS (web/scripts/notices.ts)`,
    );
  const from = own.length ? "" : "\n(The npm package ships no licence file; text from the upstream repository.)";
  return `${p.name}@${p.version}\nLicense: ${p.license}${p.homepage ? `\n${p.homepage}` : ""}${from}\n\n${texts.join("\n\n")}`;
}

const RULE = "\n\n" + "-".repeat(100) + "\n\n";
const HEAD = "=".repeat(100);

/** The run-time components' notices; `ort` is the installed onnxruntime-web version, whose wasm the app fetches. */
function runtimeSections(ort: string): string {
  return [
    `${HEAD}\nB. Loaded by the app at run time (not inside index.html)\n${HEAD}\n\n` +
      `- ONNX Runtime Web ${ort} wasm (ort-wasm-simd-threaded.asyncify.wasm), fetched from cdn.jsdelivr.net\n` +
      `  (npm onnxruntime-web@${ort}): MIT, Copyright (c) Microsoft Corporation. Its third-party notices are in C.1.\n` +
      "- SAM 3 model files (vision and text encoders and tokenizer from Hugging Face, detectors from models/):\n" +
      "  the SAM License, NOT an open-source licence: models/LICENSE-SAM.txt, models/NOTICE-SAM.txt. Text in C.2.\n" +
      "- DINOv2 small (models/dinov2-small/model_cls.onnx): Apache-2.0, modified (CLS-token output):\n" +
      "  models/dinov2-small/LICENSE.txt, models/dinov2-small/NOTICE.txt. Text in C.3.",
    `${HEAD}\nC.1 ONNX Runtime ${ort}: LICENSE and ThirdPartyNotices.txt\n${HEAD}\n\n` +
      read("third_party/onnxruntime/LICENSE").trim() +
      "\n\n" +
      read("third_party/onnxruntime/ThirdPartyNotices.txt").trim(),
    `${HEAD}\nC.2 SAM 3 model files: NOTICE and the SAM License\n${HEAD}\n\n` +
      read("third_party/sam3/NOTICE").trim() +
      "\n\n" +
      read("third_party/sam3/LICENSE").trim(),
    `${HEAD}\nC.3 DINOv2: NOTICE and the Apache License 2.0\n${HEAD}\n\n` +
      read("third_party/dinov2/NOTICE").trim() +
      "\n\n" +
      read("third_party/dinov2/LICENSE").trim(),
  ].join("\n\n\n");
}

/** Files copied into dist/ beside what they cover, as dist path and repo-relative source. */
const COPIES: Readonly<Record<string, string>> = {
  "LICENSE.txt": "LICENSE",
  "models/LICENSE-SAM.txt": "third_party/sam3/LICENSE",
  "models/NOTICE-SAM.txt": "third_party/sam3/NOTICE",
  "models/dinov2-small/LICENSE.txt": "third_party/dinov2/LICENSE",
  "models/dinov2-small/NOTICE.txt": "third_party/dinov2/NOTICE",
};

/** sha256 (hex) of a file's bytes. */
export const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Where the SAM License copy goes in dist/, and its sha256 (the exact bytes shipped there). */
export const SAM_LICENSE_COPY = "models/LICENSE-SAM.txt";
export const samLicenseSha256 = (): string => sha256File(path.join(REPO, COPIES[SAM_LICENSE_COPY] ?? ""));

/**
 * One plugin for the page build and one for the worker build, sharing what they saw. Vite bundles the worker
 * (`?worker&inline`) while the page build transforms, so its chunks are in by the time the page's generateBundle runs.
 */
export function thirdPartyNotices(): { page: Plugin; worker: () => Plugin } {
  const webDir = path.join(REPO, "web");
  const dirs = new Set<string>();
  const collect = (bundle: Record<string, { type: string; moduleIds?: readonly string[] }>) => {
    for (const out of Object.values(bundle))
      if (out.type === "chunk")
        for (const id of out.moduleIds ?? []) {
          const dir = packageOf(id, webDir);
          if (dir) dirs.add(dir);
        }
  };
  const worker = (): Plugin => ({
    name: "third-party-notices-worker",
    apply: "build",
    generateBundle(_, bundle) {
      collect(bundle);
    },
  });
  const page: Plugin = {
    name: "third-party-notices",
    apply: "build",
    generateBundle(_, bundle) {
      collect(bundle);
      const pkgs = new Map<string, Pkg>();
      for (const d of dirs) {
        const p = readPkg(d);
        pkgs.set(`${p.name}@${p.version}`, p);
      }
      const sorted = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
      const intro =
        "Third-party notices for this web app (generated by web/scripts/notices.ts at build time; do not edit).\n" +
        "The app's own code is licensed under the Apache License 2.0 (LICENSE.txt). It contains or loads the\n" +
        "third-party components below, under their own licences.\n\n" +
        `A. npm packages bundled into index.html (${sorted.length}): ` +
        sorted.map((p) => `${p.name}@${p.version} (${p.license})`).join(", ") +
        "\nB. Loaded at run time: ONNX Runtime wasm, SAM 3 and DINOv2 model files\n" +
        "C. Full licence texts for B";
      const ort = readPkg(path.join(webDir, "node_modules", "onnxruntime-web")).version;
      const npm = `${HEAD}\nA. npm packages bundled into index.html\n${HEAD}\n\n` + sorted.map(section).join(RULE);
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: [intro, npm, runtimeSections(ort)].join("\n\n\n") + "\n",
      });
      for (const [fileName, from] of Object.entries(COPIES)) {
        if (!existsSync(path.join(REPO, from))) throw new Error(`notices: missing ${from}`);
        this.emitFile({ type: "asset", fileName, source: readFileSync(path.join(REPO, from)) });
      }
    },
  };
  return { page, worker };
}
