import { after, describe, it } from "node:test";
import { RuleTester } from "@typescript-eslint/rule-tester";
import rule from "./must-use-result.js";

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: ["*.ts"] },
      tsconfigRootDir: import.meta.dirname,
    },
  },
});

const prelude = `
import { ok, err, okAsync, Result, ResultAsync } from "neverthrow";
declare function save(x: number): Result<number, string>;
declare function saveAsync(x: number): ResultAsync<number, string>;
declare function later(x: number): Promise<Result<number, string>>;
declare function plain(x: number): number;
`;

tester.run("must-use-result", rule, {
  valid: [
    `${prelude} plain(1);`,
    `${prelude} const r = save(1); r.match((v) => v, (e) => e.length);`,
    `${prelude} save(1).match((v) => v, () => 0);`,
    `${prelude} if (save(1).isErr()) plain(2);`,
    `${prelude} function f() { return save(1); }`,
    `${prelude} const f = () => save(1).map((v) => v + 1);`,
    `${prelude} async function f() { return await saveAsync(1); }`,
    `${prelude} async function f() { const r = await later(1); return r.unwrapOr(0); }`,
    `${prelude} const xs = [1, 2].map((x) => save(x));`,
    `${prelude} plain(save(1).unwrapOr(0));`,
  ],
  invalid: [
    { code: `${prelude} save(1);`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} ok(1);`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} err("no");`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} save(1).map((v) => v + 1);`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} saveAsync(1);`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} okAsync(1).andThen((v) => saveAsync(v));`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} async function f() { await saveAsync(1); }`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} async function f() { await later(1); }`, errors: [{ messageId: "dropped" }] },
    { code: `${prelude} void save(1);`, errors: [{ messageId: "voided" }] },
    { code: `${prelude} void later(1);`, errors: [{ messageId: "voided" }] },
    { code: `${prelude} declare const c: boolean; c ? save(1) : plain(2);`, errors: [{ messageId: "dropped" }] },
  ],
});
