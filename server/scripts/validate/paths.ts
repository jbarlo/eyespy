/**
 * Where the validation and web scripts find code and data, relative to the checkout (no absolute paths). Data lives in
 * the main checkout, also when running from a git worktree.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const CODE = path.resolve(import.meta.dirname, "../../..");

/** The main checkout of the repo at `dir` (its git common dir's parent), or `dir` itself outside git. */
function mainCheckout(dir: string): string {
  try {
    const common = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.dirname(common);
  } catch {
    return dir;
  }
}

const ROOT = mainCheckout(process.env.EYESPY_ROOT ?? CODE);
export const MODELS = process.env.EYESPY_MODELS ?? path.join(ROOT, "models", "onnx");
/** Default output folder for a script's run. */
export const scratch = (name: string): string => path.join(ROOT, "scratch", name);
