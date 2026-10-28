import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { samLicenseSha256, thirdPartyNotices } from "./scripts/notices.ts";

function git() {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * onnxruntime-web's default wasm location is `new URL("<wasm>", import.meta.url)`, which Vite would turn into an
 * asset and the single-file plugin would inline, twice. The engine always sets env.wasm.wasmPaths, so hide
 * the default from Vite.
 */
const ortWasmNotAnAsset = {
  name: "ort-wasm-not-an-asset",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.includes("onnxruntime-web")) return null;
    return code.replaceAll(
      /new URL\("(ort-wasm[^"]*)",import\.meta\.url\)/g,
      'new URL("$1","https://wasm-paths-not-set.invalid/")',
    );
  },
};

// THIRD_PARTY_NOTICES.txt and the licence copies
const notices = thirdPartyNotices();

// One self-contained index.html with the worker inlined; the engine fetches models and the ort wasm at runtime.
export default defineConfig({
  plugins: [ortWasmNotAnAsset, notices.page, viteSingleFile()],
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  worker: { format: "es", plugins: () => [ortWasmNotAnAsset, notices.worker()] },
  define: {
    __EYESPY_REV__: JSON.stringify(git()),
    __EYESPY_SAM_LICENSE_SHA256__: JSON.stringify(samLicenseSha256()),
  },

  build: { target: "es2022", chunkSizeWarningLimit: 100_000 },
  server: { fs: { allow: [".."] } },
});
