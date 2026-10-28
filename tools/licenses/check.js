/**
 * Licence check over the npm dependency trees. Each production package (optionalDependencies included) must have a
 * licence policy.json allows, or match a reviewed exception. The check only reports dev-only packages, and fails on an
 * exception that matches nothing. Membership comes from `pnpm ls --prod|--dev`, not `pnpm licenses list --prod`, which
 * drops optionalDependencies (where sharp's LGPL native packages are). Packages not installed on this platform have no
 * licence data, so the check counts them without checking them.
 *
 *   node tools/licenses/check.js [--list]   --list prints the production inventory grouped by licence
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Parses an SPDX licence expression (`MIT`, `(MIT OR CC0-1.0)`, `Apache-2.0 AND BSD-3-Clause`,
 * `GPL-2.0-only WITH Classpath-exception-2.0`) into a tree. AND binds tighter than OR. Returns null if it doesn't
 * parse, as with "Unknown", "SEE LICENSE IN ..." or "Custom: ...".
 * @param {string} expr
 * @returns {null | { id: string } | { op: "AND" | "OR", left: object, right: object }}
 */
export function parseSpdx(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const ident = /^[A-Za-z0-9.+-]+$/;
  /** @returns {any} */
  function primary() {
    const t = tokens[i++];
    if (t === "(") {
      const e = or();
      if (tokens[i++] !== ")") throw new Error("missing )");
      return e;
    }
    if (t === undefined || !ident.test(t) || ["AND", "OR", "WITH"].includes(t)) throw new Error(`bad token ${t}`);
    if (peek() === "WITH") {
      i++;
      const ex = tokens[i++];
      if (ex === undefined || !ident.test(ex)) throw new Error("bad WITH");
      return { id: `${t} WITH ${ex}` };
    }
    return { id: t };
  }
  function and() {
    let left = primary();
    while (peek() === "AND" || peek() === "and") {
      i++;
      left = { op: "AND", left, right: primary() };
    }
    return left;
  }
  function or() {
    let left = and();
    while (peek() === "OR" || peek() === "or") {
      i++;
      left = { op: "OR", left, right: and() };
    }
    return left;
  }
  try {
    const tree = or();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

/**
 * Whether the allowlist satisfies an SPDX expression. OR needs one side allowed and AND needs both. `X WITH Y` passes
 * only if the allowlist has that exact string. An expression that doesn't parse never passes.
 * @param {string} expr
 * @param {ReadonlySet<string>} allow
 */
export function allowed(expr, allow) {
  const tree = parseSpdx(expr);
  /** @param {any} n @returns {boolean} */
  const ok = (n) =>
    "id" in n ? allow.has(n.id) : n.op === "OR" ? ok(n.left) || ok(n.right) : ok(n.left) && ok(n.right);
  return tree !== null && ok(tree);
}

/**
 * Every package in `pnpm ls --json` trees, by name@version, excluding workspace packages.
 * @param {any[]} projects  `pnpm ls -r --json` output
 * @returns {Map<string, { name: string, version: string, path: string }>}
 */
export function treePackages(projects) {
  const workspace = new Set(projects.map((p) => p.name));
  const out = new Map();
  /** @param {Record<string, any> | undefined} deps */
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (workspace.has(name) || String(d.version).startsWith("link:")) continue;
      const id = `${name}@${d.version}`;
      if (out.has(id)) continue;
      out.set(id, { name, version: d.version, path: d.path });
      walk(d.dependencies);
      walk(d.optionalDependencies);
    }
  };
  for (const p of projects) {
    walk(p.dependencies);
    walk(p.optionalDependencies);
    walk(p.devDependencies);
  }
  return out;
}

/**
 * Matches a package name pattern, exact or with `*` for any run of characters. `@img/sharp-libvips-*` is one exception
 * that covers every platform build.
 * @param {string} pattern @param {string} name
 */
export function matchName(pattern, name) {
  const re = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(name);
}

/**
 * Sorts packages into allowed, excepted, missing (no licence data, because not installed on this platform) and
 * violations.
 * @param {Map<string, { name: string, version: string }>} pkgs
 * @param {Map<string, string>} licenses  licence string by name@version
 * @param {{ allow: string[], exceptions: { package: string, license: string, reason: string }[] }} policy
 */
export function classify(pkgs, licenses, policy) {
  const allow = new Set(policy.allow);
  const result = { ok: [], excepted: [], missing: [], violations: [], usedExceptions: new Set() };
  for (const [id, p] of pkgs) {
    const license = licenses.get(id);
    if (license === undefined) {
      result.missing.push({ id, ...p });
      continue;
    }
    const entry = { id, ...p, license };
    if (allowed(license, allow)) {
      result.ok.push(entry);
      continue;
    }
    const ex = policy.exceptions.find((e) => matchName(e.package, p.name) && e.license === license);
    if (ex) {
      result.excepted.push({ ...entry, reason: ex.reason });
      result.usedExceptions.add(ex);
    } else result.violations.push(entry);
  }
  return result;
}

/** @param {string[]} args @param {string} cwd */
function pnpmJson(args, cwd) {
  return JSON.parse(execFileSync("pnpm", args, { cwd, encoding: "utf8", maxBuffer: 256 << 20 }));
}

/** @param {{ id: string, license?: string }[]} list */
function byLicense(list) {
  const groups = new Map();
  for (const p of list) groups.set(p.license, [...(groups.get(p.license) ?? []), p.id]);
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const policy = JSON.parse(readFileSync(path.join(root, "tools/licenses/policy.json"), "utf8"));
  const list = process.argv.includes("--list");

  const licenses = new Map();
  for (const [license, pkgs] of Object.entries(pnpmJson(["licenses", "list", "-r", "--json"], root)))
    for (const p of pkgs) for (const v of p.versions) licenses.set(`${p.name}@${v}`, license);

  const ls = (flag) => treePackages(pnpmJson(["ls", "-r", "--json", "--depth", "Infinity", flag], root));
  const prod = ls("--prod");
  const dev = new Map([...ls("--dev")].filter(([id]) => !prod.has(id)));

  const p = classify(prod, licenses, policy);
  const d = classify(dev, licenses, policy);
  const stale = policy.exceptions.filter((e) => !p.usedExceptions.has(e) && !d.usedExceptions.has(e));

  console.log(
    `licences: production ${prod.size} packages (${p.ok.length} allowed, ${p.excepted.length} excepted, ` +
      `${p.missing.length} not installed on this platform); dev-only ${dev.size}`,
  );
  if (list) {
    for (const [lic, ids] of byLicense([...p.ok, ...p.excepted]))
      console.log(`  ${lic} (${ids.length}): ${ids.join(" ")}`);
    if (p.missing.length) console.log(`  not installed here: ${p.missing.map((m) => m.id).join(" ")}`);
  }
  for (const e of p.excepted) console.log(`  excepted: ${e.id} (${e.license}): ${e.reason}`);
  for (const e of d.excepted) console.log(`  excepted (dev): ${e.id} (${e.license}): ${e.reason}`);
  for (const v of d.violations) console.log(`  dev-only, not on the allowlist (report only): ${v.id} (${v.license})`);
  for (const v of p.violations) console.error(`  NOT ALLOWED: ${v.id} (${v.license}) ${v.path}`);
  for (const e of stale) console.error(`  stale exception (matches nothing): ${e.package} (${e.license})`);
  if (p.violations.length || stale.length) {
    console.error("licences: fix the dependency or add a reviewed exception to tools/licenses/policy.json");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
