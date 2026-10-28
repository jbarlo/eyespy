import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerArgs } from "../src/args.ts";

const CODE = "/code";
const parse = (argv: string[], env: Record<string, string> = {}) => parseServerArgs(argv, env, CODE);

test("args: defaults, and flags over env", () => {
  assert.deepEqual(parse(["--session", "/s"])._unsafeUnwrap(), {
    root: "/s",
    models: "/code/models/onnx",
    detector: "fp32",
    cpu: false,
    idleMinutes: undefined,
    featureCacheMB: undefined,
    featureDiskMB: null,
    profile: false,
  });
  const env = { EYESPY_MODELS: "/m", EYESPY_DETECTOR: "fp16", EYESPY_FEATURE_CACHE_MB: "512", EYESPY_PROFILE: "1" };
  assert.deepEqual(parse(["--session", "/s", "--idle-minutes", "0.5", "--cpu"], env)._unsafeUnwrap(), {
    root: "/s",
    models: "/m",
    detector: "fp16",
    cpu: true,
    idleMinutes: 0.5,
    featureCacheMB: 512,
    featureDiskMB: null,
    profile: true,
  });
  const flags = parse(["--session", "/s", "--models", "/n", "--detector", "fp32"], env)._unsafeUnwrap();
  assert.equal(flags.models, "/n");
  assert.equal(flags.detector, "fp32");
});

test("args: the feature disk budget, flag over env; unset is unlimited (null)", () => {
  assert.equal(parse(["--session", "/s"], { EYESPY_FEATURE_DISK_MB: "4096" })._unsafeUnwrap().featureDiskMB, 4096);
  assert.equal(
    parse(["--session", "/s", "--feature-disk-mb", "1024"], { EYESPY_FEATURE_DISK_MB: "4096" })._unsafeUnwrap()
      .featureDiskMB,
    1024,
  );
  assert.equal(parse(["--session", "/s"], { EYESPY_FEATURE_DISK_MB: "" })._unsafeUnwrap().featureDiskMB, null);
  assert.match(parse(["--session", "/s", "--feature-disk-mb", "lots"])._unsafeUnwrapErr(), /--feature-disk-mb/);
  assert.match(parse(["--session", "/s"], { EYESPY_FEATURE_DISK_MB: "0" })._unsafeUnwrapErr(), /must be > 0/);
});

test("args: empty env values count as unset", () => {
  const a = parse(["--session", "/s"], { EYESPY_FEATURE_CACHE_MB: "", EYESPY_DETECTOR: "", EYESPY_PROFILE: "" });
  assert.deepEqual(a.map((x) => [x.featureCacheMB, x.detector, x.profile])._unsafeUnwrap(), [undefined, "fp32", false]);
});

test("args: a value that isn't a positive number is an error (NaN would mean an unbounded cache)", () => {
  assert.match(
    parse(["--session", "/s"], { EYESPY_FEATURE_CACHE_MB: "4G" })._unsafeUnwrapErr(),
    /EYESPY_FEATURE_CACHE_MB/,
  );
  assert.match(parse(["--session", "/s"], { EYESPY_FEATURE_CACHE_MB: "0" })._unsafeUnwrapErr(), /must be > 0/);
  assert.match(parse(["--session", "/s", "--idle-minutes", "soon"])._unsafeUnwrapErr(), /--idle-minutes/);
});

test("args: a bad detector, a missing session or an unknown flag is an error, not a throw", () => {
  assert.match(parse(["--session", "/s", "--detector", "int8"])._unsafeUnwrapErr(), /--detector: must be fp32 or fp16/);
  assert.match(parse(["--session", "/s"], { EYESPY_DETECTOR: "int8" })._unsafeUnwrapErr(), /EYESPY_DETECTOR/);
  assert.match(parse([])._unsafeUnwrapErr(), /--session: required/);
  assert.match(parse(["--session", "/s", "--gpu"])._unsafeUnwrapErr(), /--gpu/);
});
