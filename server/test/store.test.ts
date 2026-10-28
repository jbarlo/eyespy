/** FsStore against the SessionStore contract, plus what only a filesystem store can show. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sessionStoreContract } from "../../core/test/contract/session-store.ts";
import { FsStore } from "../src/adapters/store.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "eyespy-store-"));

/** A store over a fresh temp session folder, which `body` runs against and which is then removed. */
async function withStore(body: (s: FsStore, root: string) => Promise<void>) {
  const root = tmp();
  try {
    await body(new FsStore(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

sessionStoreContract("FsStore", async () => {
  const root = tmp();
  return { store: new FsStore(root), dispose: async () => rmSync(root, { recursive: true, force: true }) };
});

test("FsStore: keys are files under <root>/.eyespy; locate gives that path", () =>
  withStore(async (s, root) => {
    await s.writeText("clips/k/meta.json", "{}");
    assert.equal(readFileSync(path.join(root, ".eyespy/clips/k/meta.json"), "utf8"), "{}");
    assert.equal(s.locate("dets/1.png"), path.join(root, ".eyespy/dets/1.png"));
  }));

test("FsStore: a write goes through a temp file renamed over the target (none left behind)", () =>
  withStore(async (s, root) => {
    await s.write("feat/1.bin", new Uint8Array(1000).fill(1));
    await s.write("feat/1.bin", new Uint8Array(10).fill(2));
    assert.deepEqual(readdirSync(path.join(root, ".eyespy/feat")), ["1.bin"]);
    assert.equal(existsSync(path.join(root, ".eyespy/feat/1.bin.tmp")), false);
  }));

test("FsStore: a big read is the file's bytes, a view over the one buffer it was read into", () =>
  withStore(async (s) => {
    const n = 1 << 20;
    await s.write(
      "feat/big.bin",
      new Uint8Array(n).map((_, i) => i & 255),
    );
    const got = await s.read("feat/big.bin");
    assert.ok(got);
    assert.equal(got.byteLength, n);
    assert.equal(got[n - 1], (n - 1) & 255);
    assert.equal(got.buffer.byteLength, n);
  }));
