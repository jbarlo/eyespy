/** Run against MemStore and the server's FsStore, so the fake the core tests use behaves like the real store. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStore } from "../../src/ports/index.ts";

export type OpenStore = () => Promise<{ readonly store: SessionStore; readonly dispose?: () => Promise<void> }>;

const bytes = (...xs: number[]) => new Uint8Array(xs);
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

export function sessionStoreContract(name: string, open: OpenStore): void {
  const rule = (what: string, body: (s: SessionStore) => Promise<void>): void => {
    test(`${name} contract: ${what}`, async () => {
      const { store, dispose } = await open();
      try {
        await body(store);
      } finally {
        await dispose?.();
      }
    });
  };

  rule("a missing file is null / false, never a rejection", async (s) => {
    assert.equal(await s.read("dets/1.2.npz"), null);
    assert.equal(await s.readText("session.json"), null);
    assert.equal(await s.exists("session.json"), false);
    assert.equal(await s.size("clips/k/feat/1.bin"), null);
  });

  rule("write / read and writeText / readText round-trip; size is the byte length", async (s) => {
    await s.write("clips/k/feat/7.bin", bytes(1, 2, 3, 250));
    assert.deepEqual(await s.read("clips/k/feat/7.bin"), bytes(1, 2, 3, 250));
    assert.equal(await s.size("clips/k/feat/7.bin"), 4);
    assert.equal(await s.exists("clips/k/feat/7.bin"), true);
    await s.writeText("session.json", '{"é": 1}');
    assert.equal(await s.readText("session.json"), '{"é": 1}');
    assert.equal(text(await s.read("session.json")), '{"é": 1}');
    assert.equal(await s.size("session.json"), 9);
  });

  rule("a write replaces the whole file", async (s) => {
    await s.write("a.bin", bytes(1, 2, 3, 4, 5));
    await s.write("a.bin", bytes(9));
    assert.deepEqual(await s.read("a.bin"), bytes(9));
    await s.writeText("objects.json", "a long first version");
    await s.writeText("objects.json", "short");
    assert.equal(await s.readText("objects.json"), "short");
  });

  rule("the store keeps no reference to a written buffer; a read buffer is the caller's", async (s) => {
    const data = bytes(1, 2, 3);
    await s.write("a.bin", data);
    data[0] = 99; // the caller reuses its buffer after the write
    const got = await s.read("a.bin");
    assert.deepEqual(got, bytes(1, 2, 3));
    got?.fill(7); // the caller keeps (and may change) what it read
    assert.deepEqual(await s.read("a.bin"), bytes(1, 2, 3));
  });

  rule("a read buffer is a usable view (its offset and length describe exactly the file)", async (s) => {
    await s.write("f.bin", bytes(10, 20, 30, 40));
    const got = await s.read("f.bin");
    assert.ok(got);
    assert.deepEqual([...new Uint8Array(got.buffer, got.byteOffset, got.byteLength)], [10, 20, 30, 40]);
  });

  rule("appendText creates the file (and its folders), then appends", async (s) => {
    await s.appendText("logs/ops.jsonl", "a\n");
    await s.appendText("logs/ops.jsonl", "b\n");
    assert.equal(await s.readText("logs/ops.jsonl"), "a\nb\n");
  });

  rule("exists is about files: a folder that only holds files is not one", async (s) => {
    await s.write("clips/k/frames/1.jpg", bytes(1));
    assert.equal(await s.exists("clips/k/frames"), false);
    assert.equal(await s.exists("clips"), false);
    assert.equal(await s.read("clips/k/frames"), null);
    assert.equal(await s.size("clips/k"), null);
  });

  rule("remove deletes one file; a missing one is a no-op", async (s) => {
    await s.write("dets/1.npz", bytes(1));
    await s.remove("dets/1.npz");
    assert.equal(await s.exists("dets/1.npz"), false);
    await s.remove("dets/1.npz");
    await s.remove("never/was.bin");
  });

  rule("removeDir deletes everything under a folder and nothing beside it; missing is a no-op", async (s) => {
    await s.write("clips/k/feat/1.bin", bytes(1));
    await s.write("clips/k/frames/1.jpg", bytes(2));
    await s.write("clips/kk/feat/1.bin", bytes(3)); // shares the prefix "clips/k"
    await s.writeText("clips/k.json", "{}");
    await s.removeDir("clips/k");
    assert.equal(await s.exists("clips/k/feat/1.bin"), false);
    assert.equal(await s.exists("clips/k/frames/1.jpg"), false);
    assert.deepEqual(await s.read("clips/kk/feat/1.bin"), bytes(3));
    assert.equal(await s.readText("clips/k.json"), "{}");
    await s.removeDir("clips/k");
    await s.removeDir("not/there");
  });

  rule("list: the files directly in a folder with their sizes; sub-folders and neighbours left out", async (s) => {
    await s.write("clips/k/feat/000.f16", bytes(1, 2, 3));
    await s.write("clips/k/feat/001.f16", bytes(4));
    await s.write("clips/k/feat/deeper/002.f16", bytes(5)); // in a sub-folder, so not listed
    await s.write("clips/kk/feat/000.f16", bytes(6)); // shares the prefix "clips/k"
    const got = (await s.list("clips/k/feat")).map((f) => [f.name, f.size]).sort();
    assert.deepEqual(got, [
      ["000.f16", 3],
      ["001.f16", 1],
    ]);
    assert.deepEqual(await s.list("clips/k"), [], "a folder holding only folders lists nothing");
  });

  rule("list: a missing folder is empty, never a rejection; removed files are gone from it", async (s) => {
    assert.deepEqual(await s.list("clips/none/feat"), []);
    await s.write("clips/k/feat/000.f16", bytes(1));
    await s.remove("clips/k/feat/000.f16");
    assert.deepEqual(await s.list("clips/k/feat"), []);
    await s.write("clips/k/feat/000.f16", bytes(1));
    await s.removeDir("clips/k");
    assert.deepEqual(await s.list("clips/k/feat"), []);
  });

  rule("list: mtimes are epoch ms, a later write never older; a rewrite moves the file's mtime on", async (s) => {
    const before = Date.now() - 5000; // some filesystems round the mtime down
    await s.write("f/a.bin", bytes(1));
    await new Promise((r) => setTimeout(r, 20));
    await s.write("f/b.bin", bytes(2));
    const m1 = new Map((await s.list("f")).map((f) => [f.name, f.mtime]));
    const a = m1.get("a.bin") ?? -1;
    const b = m1.get("b.bin") ?? -1;
    assert.ok(a >= before && a <= Date.now() + 5000, `mtime ${a} is not epoch ms`);
    assert.ok(b >= a, `b (${b}) written after a (${a})`);
    await new Promise((r) => setTimeout(r, 20));
    await s.write("f/a.bin", bytes(3));
    const a2 = (await s.list("f")).find((f) => f.name === "a.bin")?.mtime ?? -1;
    assert.ok(a2 >= b, `rewritten a (${a2}) not older than b (${b})`);
  });

  rule("a key that escapes the session folder is rejected (a host failure), for reads and writes", async (s) => {
    for (const key of ["../outside.txt", "a/../../outside.txt", "/etc/passwd"]) {
      await assert.rejects(s.readText(key), `readText ${key}`);
      await assert.rejects(s.writeText(key, "x"), `writeText ${key}`);
      await assert.rejects(s.write(key, bytes(1)), `write ${key}`);
      await assert.rejects(s.exists(key), `exists ${key}`);
      await assert.rejects(s.list(key), `list ${key}`);
    }
  });

  rule("locate is stable per key and tells keys apart", async (s) => {
    assert.equal(s.locate("dets/1.png"), s.locate("dets/1.png"));
    assert.notEqual(s.locate("dets/1.png"), s.locate("dets/2.png"));
    assert.equal(typeof s.root, "string");
  });
}
