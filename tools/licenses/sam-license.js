/**
 * Compares third_party/sam3/LICENSE with the SAM License upstream. When the text differs, it writes the new text and
 * updates what quotes it: the sha256, the upstream commit and the "Last Updated" date in THIRD_PARTY.md, and the date
 * in third_party/sam3/NOTICE. The repo copy is the upstream bytes plus a final newline if upstream lacks one. A failed
 * fetch, a redirect, or a reference it can't find exits non-zero.
 *
 *   node tools/licenses/sam-license.js [--upstream <file>] [--root <dir>] [--body <file>]
 *
 * --upstream reads the new text from a file instead of fetching it, --root works on another copy of the repo, and
 * --body writes a pull request description there when the text changed. Under GitHub Actions it sets the step output
 * `changed` to true or false.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const UPSTREAM = "https://raw.githubusercontent.com/facebookresearch/sam3/main/LICENSE";
const COMMITS_API = "https://api.github.com/repos/facebookresearch/sam3/commits?path=LICENSE&sha=main&per_page=1";
const HISTORY = "https://github.com/facebookresearch/sam3/commits/main/LICENSE";
const FILES = { license: "third_party/sam3/LICENSE", notice: "third_party/sam3/NOTICE", thirdParty: "THIRD_PARTY.md" };
const COMMIT_REF = /\(file last changed in commit `[0-9a-f]+`, "[^"]*"\)/g;
const MAX_DIFF = 50_000;

/** @typedef {{ thirdParty: string, notice: string }} Docs */
/** @typedef {{ sha: string, title: string }} Commit */
/** @typedef {{ sha256: string, date: string }} Quoted */

/** The bytes the repo keeps for an upstream text: the text, ending in a newline. @param {string} text */
export const asRepoCopy = (text) => (text.endsWith("\n") ? text : `${text}\n`);

/** @param {string} text */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The licence's "Last Updated:" date, as written. @param {string} text */
export function lastUpdated(text) {
  const m = /^Last Updated: *(\S.*?) *$/m.exec(text);
  if (!m?.[1]) throw new Error('the licence has no "Last Updated:" line; update third_party/sam3 by hand');
  return m[1];
}

/**
 * Replaces the one match of `from` in `text`. More or fewer than one match throws, so a reworded document fails the
 * update instead of keeping a stale reference.
 * @param {string} text @param {string | RegExp} from @param {string} to @param {string} where
 */
function replaceOne(text, from, to, where) {
  const re = typeof from === "string" ? new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : from;
  const n = [...text.matchAll(re)].length;
  if (n !== 1) throw new Error(`${where}: expected one ${String(from)}, found ${n}`);
  return text.replace(re, () => to);
}

/**
 * THIRD_PARTY.md and the NOTICE with every reference to the old licence text moved to the new one.
 * @param {Docs} docs @param {Quoted} old @param {Quoted & { commit: Commit }} next
 * @returns {Docs}
 */
export function updateReferences(docs, old, next) {
  const date = (/** @type {string} */ d) => `"Last Updated: ${d}"`;
  const title = next.commit.title.replace(/["`|\\]/g, "'");
  let thirdParty = replaceOne(docs.thirdParty, old.sha256, next.sha256, FILES.thirdParty);
  thirdParty = replaceOne(thirdParty, date(old.date), date(next.date), FILES.thirdParty);
  thirdParty = replaceOne(
    thirdParty,
    COMMIT_REF,
    `(file last changed in commit \`${next.commit.sha.slice(0, 8)}\`, "${title}")`,
    FILES.thirdParty,
  );
  const notice = replaceOne(docs.notice, date(old.date), date(next.date), FILES.notice);
  return { thirdParty, notice };
}

/**
 * The pull request description for a licence change.
 * @param {Quoted} old @param {Quoted & { commit: Commit }} next @param {string} diff
 */
export function prBody(old, next, diff) {
  const shown = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n... (cut; see the Files tab)\n` : diff;
  const fence = shown.includes("```") ? "~~~~" : "```";
  return [
    `The SAM License at ${UPSTREAM} no longer matches \`${FILES.license}\`.`,
    "",
    `- Last Updated: ${old.date} -> ${next.date}`,
    `- sha256: \`${old.sha256}\` -> \`${next.sha256}\``,
    `- Upstream last changed the file in https://github.com/facebookresearch/sam3/commit/${next.commit.sha} ` +
      `("${next.commit.title}"). History: ${HISTORY}`,
    "",
    "**Merging this accepts the new terms on behalf of the project.** The app stores each user's agreement against " +
      "the sha256 of the licence text it ships, so the next deploy asks every user to agree again. Read the whole " +
      "diff before merging. Nothing merges this automatically.",
    "",
    `This pull request writes the new text to \`${FILES.license}\` and updates its sha256, upstream commit and date ` +
      `in \`${FILES.thirdParty}\` and its date in \`${FILES.notice}\`. After the merge, the sam-license-hf workflow ` +
      "uploads the licence and notice to huggingface.co/jbarlo/eyespy-models (sam3/).",
    "",
    "Check by hand before merging:",
    "",
    `- \`${FILES.thirdParty}\` and \`${FILES.notice}\` say this text is the same as the \`LICENSE\` of ` +
      "CardAnvilModels/sam3-ONNX and facebook/sam3 on Hugging Face. Compare them again and correct those lines.",
    "- Whether the project can still distribute and use the SAM 3 files as it does under the new text.",
    "",
    "Licence diff:",
    "",
    `${fence}diff`,
    shown.trimEnd(),
    fence,
    "",
  ].join("\n");
}

/** Unified diff of two texts, labelled with the licence's repo path. @param {string} a @param {string} b */
function diffTexts(a, b) {
  const dir = mkdtempSync(path.join(tmpdir(), "sam-license-"));
  try {
    for (const [side, text] of [
      ["a", a],
      ["b", b],
    ]) {
      const file = path.join(dir, side, FILES.license);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const args = ["diff", "--no-index", "--no-color", "--no-prefix", `a/${FILES.license}`, `b/${FILES.license}`];
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr || String(r.error)}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fetch that fails on any status but 200, redirects included. @param {string} url @param {HeadersInit} headers */
async function get(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "manual" });
  if (res.status !== 200) {
    const to = res.headers.get("location");
    throw new Error(`${url}: HTTP ${res.status}${to ? ` (redirects to ${to}; did upstream move?)` : ""}`);
  }
  return res;
}

/** The latest upstream commit that touched LICENSE. @returns {Promise<Commit>} */
async function latestCommit() {
  const token = process.env.GITHUB_TOKEN;
  const headers = { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const list = /** @type {unknown} */ (await (await get(COMMITS_API, headers)).json());
  const c = /** @type {{ sha?: unknown, commit?: { message?: unknown } } | undefined} */ (
    Array.isArray(list) ? list[0] : undefined
  );
  const message = c?.commit?.message;
  if (typeof c?.sha !== "string" || typeof message !== "string")
    throw new Error(`${COMMITS_API}: no commit in the reply`);
  return { sha: c.sha, title: message.split("\n")[0] ?? "" };
}

/** @param {string} name @param {string} value */
function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: { upstream: { type: "string" }, root: { type: "string" }, body: { type: "string" } },
  });
  const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const at = (/** @type {string} */ rel) => path.join(root, rel);

  const source = values.upstream ?? UPSTREAM;
  const upstream = values.upstream ? readFileSync(values.upstream, "utf8") : await (await get(UPSTREAM)).text();
  const current = readFileSync(at(FILES.license), "utf8");
  const next = asRepoCopy(upstream);
  if (next === current) {
    console.log(`sam-license: ${FILES.license} matches ${source}`);
    output("changed", "false");
    return;
  }

  const old = { sha256: sha256(current), date: lastUpdated(current) };
  const quoted = { sha256: sha256(next), date: lastUpdated(next), commit: await latestCommit() };
  const docs = updateReferences(
    { thirdParty: readFileSync(at(FILES.thirdParty), "utf8"), notice: readFileSync(at(FILES.notice), "utf8") },
    old,
    quoted,
  );
  writeFileSync(at(FILES.license), next);
  writeFileSync(at(FILES.thirdParty), docs.thirdParty);
  writeFileSync(at(FILES.notice), docs.notice);
  if (values.body) writeFileSync(values.body, prBody(old, quoted, diffTexts(current, next)));
  console.log(
    `sam-license: upstream changed (Last Updated: ${old.date} -> ${quoted.date}, sha256 ${quoted.sha256}); ` +
      `updated ${Object.values(FILES).join(", ")}`,
  );
  output("changed", "true");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((/** @type {unknown} */ e) => {
    console.error(`sam-license: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
