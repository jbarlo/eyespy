/**
 * `pnpm --filter eyespy build` bundles src/main.ts and its imports into one ESM file, so Node loads no TypeScript at
 * run time. The build writes a temp file and renames it, so a parallel call never loads a half-written bundle.
 */
import { rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const CLI = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.argv[2] ?? path.join(CLI, "dist/eyespy.mjs"));

const result = await build({
  entryPoints: [path.join(CLI, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  outfile: out,
  logLevel: "warning",
  // The bundle is built and run on the user's machine and never distributed. Publishing it would need notices.
  legalComments: "none",
  // Some dependencies are CommonJS, so the ESM bundle needs a `require`.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
});
const file = result.outputFiles[0];
if (!file) throw new Error("esbuild produced no output");
await mkdir(path.dirname(out), { recursive: true });
const tmp = `${out}.${process.pid}.tmp`;
await writeFile(tmp, file.contents);
await rename(tmp, out);
