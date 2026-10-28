/**
 * WCAG contrast of the stylesheet's text tokens on their backgrounds (4.5:1 is AA for body text). The light theme
 * overrides only some tokens, so inherited dark-theme colours are checked on light backgrounds too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/ui/app.css", import.meta.url), "utf8");

/** The `--name: #hex` declarations of the first block that starts at `selector`. */
function tokens(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!]));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const dark = tokens(":root {");
const light = { ...dark, ...tokens(':root:not([data-theme="dark"]) {') };
/**
 * Text colour tokens and the backgrounds they're drawn on: panels and dialogs (--panel), buttons (--panel2), the page
 * (--bg; plain and muted text only). --warn colours "no" for eviction protection and a session over the disk budget.
 */
const TEXT: Record<string, string[]> = {
  "--fg": ["--panel", "--panel2", "--bg"],
  "--muted": ["--panel", "--panel2", "--bg"],
  "--danger": ["--panel", "--panel2"],
  "--warn": ["--panel", "--panel2"],
};

for (const [name, theme] of [
  ["dark", dark],
  ["light", light],
] as const)
  test(`${name} theme: text tokens reach 4.5:1 on their backgrounds`, () => {
    for (const [t, bgs] of Object.entries(TEXT))
      for (const bg of bgs) {
        const r = contrast(theme[t]!, theme[bg]!);
        assert.ok(r >= 4.5, `${t} ${theme[t]} on ${bg} ${theme[bg]}: ${r.toFixed(2)}:1`);
      }
  });
