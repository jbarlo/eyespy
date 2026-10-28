/** The help text names only CLI flags, commands and environment variables that exist. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_KEYS } from "eyespy-core/session/pure";
import { globalOptions } from "../../cli/src/commands/flags.ts";
import { envNames, flagNames } from "../../server/src/args.ts";
import { HELP, LAYER_HELP, PANEL_HELP, PREFERENCE_HELP, TOOL_HELP, settingHelp } from "../src/ui/help.ts";
import type { Help } from "../src/ui/help.ts";

const commandModules = await Promise.all(
  ["config", "export", "find", "history", "label", "look", "videos"].map(
    (m) => import(`../../cli/src/commands/${m}.ts`) as Promise<{ specs: Record<string, unknown> }>,
  ),
);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every command name and option name in a jimkit-cli spec tree. */
function walk(specs: Record<string, unknown>, commands: Set<string>, options: Set<string>) {
  for (const [name, spec] of Object.entries(specs)) {
    commands.add(name);
    const s = spec as { options?: Record<string, unknown>; subcommands?: Record<string, unknown> };
    for (const o of Object.keys(s.options ?? {})) options.add(kebab(o));
    if (s.subcommands) walk(s.subcommands, commands, options);
  }
}

const commands = new Set<string>();
const options = new Set<string>([...flagNames, ...Object.keys(globalOptions).map(kebab)]);
for (const m of commandModules) walk(m.specs, commands, options);

const texts = [
  ...Object.values(PREFERENCE_HELP),
  ...Object.values(HELP),
  ...Object.values(TOOL_HELP),
  ...Object.values(LAYER_HELP),
  ...Object.values(PANEL_HELP),
  ...CONFIG_KEYS.map(settingHelp),
].flatMap((h: Help) => [h.tip, h.more ?? ""]);

test("help names only environment variables the server reads", () => {
  const named = texts.flatMap((t) => t.match(/\bEYESPY_[A-Z_]+/g) ?? []);
  assert.ok(named.length > 0);
  for (const v of named) assert.ok(envNames.includes(v), `${v} is not read by the server`);
});

test("help names only flags the server or the CLI takes", () => {
  const named = texts.flatMap((t) => [...t.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map((m) => m[1] ?? ""));
  assert.ok(named.length > 0);
  for (const f of named) assert.ok(options.has(f), `--${f} is not a server or CLI flag`);
});

test("help names only CLI commands that exist", () => {
  const named = texts.flatMap((t) => [...t.matchAll(/(?:CLI's|CLI:|as) eyespy ([a-z]+)/g)].map((m) => m[1] ?? ""));
  assert.ok(named.length > 0);
  for (const c of named) assert.ok(commands.has(c), `eyespy ${c} is not a CLI command`);
});
