import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowed, classify, matchName, parseSpdx, treePackages } from "./check.js";

const ALLOW = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "CC0-1.0"]);

describe("parseSpdx", () => {
  it("parses ids, OR/AND with AND binding tighter, parentheses and WITH", () => {
    assert.deepEqual(parseSpdx("MIT"), { id: "MIT" });
    assert.deepEqual(parseSpdx("MIT OR Apache-2.0 AND GPL-3.0-only"), {
      op: "OR",
      left: { id: "MIT" },
      right: { op: "AND", left: { id: "Apache-2.0" }, right: { id: "GPL-3.0-only" } },
    });
    assert.deepEqual(parseSpdx("(MIT OR CC0-1.0)"), { op: "OR", left: { id: "MIT" }, right: { id: "CC0-1.0" } });
    assert.deepEqual(parseSpdx("GPL-2.0-only WITH Classpath-exception-2.0"), {
      id: "GPL-2.0-only WITH Classpath-exception-2.0",
    });
  });
  it("rejects what isn't an expression", () => {
    for (const s of ["", "Unknown License", "SEE LICENSE IN LICENSE.md", "(MIT", "MIT OR", "MIT )", "Custom: http://x"])
      assert.equal(parseSpdx(s), null, s);
  });
});

describe("allowed", () => {
  it("OR needs one allowed side, AND needs both", () => {
    assert.equal(allowed("MIT", ALLOW), true);
    assert.equal(allowed("(MIT OR CC0-1.0)", ALLOW), true);
    assert.equal(allowed("(GPL-3.0-only OR MIT)", ALLOW), true);
    assert.equal(allowed("Apache-2.0 AND MIT", ALLOW), true);
    assert.equal(allowed("Apache-2.0 AND GPL-3.0-only", ALLOW), false);
    assert.equal(allowed("(MIT AND LGPL-3.0-or-later) OR BSD-3-Clause", ALLOW), true);
  });
  it("never matches by substring or on unknown/custom text", () => {
    for (const s of ["LGPL-3.0-or-later", "MIT-CMU", "BSD-3-Clause-No-Nuclear-License", "Unknown", "UNLICENSED"])
      assert.equal(allowed(s, ALLOW), false, s);
    assert.equal(allowed("Apache-2.0 WITH LLVM-exception", ALLOW), false);
    assert.equal(allowed("Apache-2.0 WITH LLVM-exception", new Set(["Apache-2.0 WITH LLVM-exception"])), true);
  });
});

describe("matchName", () => {
  it("is exact unless the pattern has *", () => {
    assert.equal(matchName("sharp", "sharp"), true);
    assert.equal(matchName("sharp", "sharp-x"), false);
    assert.equal(matchName("@img/sharp-libvips-*", "@img/sharp-libvips-darwin-arm64"), true);
    assert.equal(matchName("@img/sharp-libvips-*", "@img/sharp-linux-x64"), false);
  });
});

describe("treePackages", () => {
  it("walks dependencies and optionalDependencies, skips workspace packages and links, dedupes", () => {
    const projects = [
      { name: "ws-a", dependencies: { "ws-b": { version: "link:../b" } } },
      {
        name: "ws-b",
        dependencies: {
          x: { version: "1.0.0", path: "/x", dependencies: { y: { version: "2.0.0", path: "/y" } } },
          z: { version: "1.0.0", path: "/z", optionalDependencies: { w: { version: "3.0.0", path: "/w" } } },
        },
        optionalDependencies: { y: { version: "2.0.0", path: "/y" } },
      },
    ];
    assert.deepEqual([...treePackages(projects).keys()].sort(), ["w@3.0.0", "x@1.0.0", "y@2.0.0", "z@1.0.0"]);
  });
});

describe("classify", () => {
  const policy = {
    allow: [...ALLOW],
    exceptions: [{ package: "lib-*", license: "LGPL-3.0-or-later", reason: "r" }],
  };
  const pkgs = new Map([
    ["a@1", { name: "a", version: "1" }],
    ["lib-x@1", { name: "lib-x", version: "1" }],
    ["lib-y@1", { name: "lib-y", version: "1" }],
    ["gone@1", { name: "gone", version: "1" }],
  ]);
  it("sorts packages into allowed, excepted (exact licence only), missing and violations", () => {
    const lic = new Map([
      ["a@1", "MIT"],
      ["lib-x@1", "LGPL-3.0-or-later"],
      ["lib-y@1", "GPL-3.0-only"],
    ]);
    const r = classify(pkgs, lic, policy);
    assert.deepEqual(
      r.ok.map((p) => p.id),
      ["a@1"],
    );
    assert.deepEqual(
      r.excepted.map((p) => p.id),
      ["lib-x@1"],
    );
    assert.deepEqual(
      r.violations.map((p) => p.id),
      ["lib-y@1"],
    );
    assert.deepEqual(
      r.missing.map((p) => p.id),
      ["gone@1"],
    );
    assert.equal(r.usedExceptions.size, 1);
  });
});
