import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { asRepoCopy, lastUpdated, prBody, sha256, updateReferences } from "./sam-license.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (/** @type {string} */ rel) => readFileSync(path.join(ROOT, rel), "utf8");
const LICENSE = read("third_party/sam3/LICENSE");
const DOCS = { thirdParty: read("THIRD_PARTY.md"), notice: read("third_party/sam3/NOTICE") };
const OLD = { sha256: sha256(LICENSE), date: lastUpdated(LICENSE) };
const NEXT = {
  sha256: "f".repeat(64),
  date: "March 3, 2027",
  commit: { sha: "0123456789abcdef0123456789abcdef01234567", title: 'Update "LICENSE" | terms' },
};

describe("asRepoCopy", () => {
  it("adds a final newline only when the text lacks one", () => {
    assert.equal(asRepoCopy("a\nb"), "a\nb\n");
    assert.equal(asRepoCopy("a\nb\n"), "a\nb\n");
    assert.equal(asRepoCopy("a\n\n"), "a\n\n");
  });
});

describe("lastUpdated", () => {
  it("reads the date line, and throws without one", () => {
    assert.equal(lastUpdated("SAM License\nLast Updated: March 3, 2027 \n\nterms"), "March 3, 2027");
    assert.throws(() => lastUpdated("SAM License\n\nterms"), /Last Updated/);
  });
});

describe("the repo's references", () => {
  it("quote the sha256 and date of third_party/sam3/LICENSE", () => {
    assert.ok(DOCS.thirdParty.includes(`\`${OLD.sha256}\``), "THIRD_PARTY.md has the licence's sha256");
    assert.ok(DOCS.thirdParty.includes(`"Last Updated: ${OLD.date}"`), "THIRD_PARTY.md has its date");
    assert.ok(DOCS.notice.includes(`"Last Updated: ${OLD.date}"`), "the NOTICE has its date");
  });
});

describe("updateReferences", () => {
  it("moves the sha256, date and commit to the new text and changes nothing else", () => {
    const out = updateReferences(DOCS, OLD, NEXT);
    for (const text of [out.thirdParty, out.notice]) {
      assert.ok(!text.includes(`Last Updated: ${OLD.date}`));
      assert.ok(text.includes(`"Last Updated: March 3, 2027"`));
    }
    assert.ok(!out.thirdParty.includes(OLD.sha256));
    assert.ok(out.thirdParty.includes(`\`${NEXT.sha256}\``));
    assert.ok(out.thirdParty.includes("(file last changed in commit `01234567`, \"Update 'LICENSE' ' terms\")"));
    const lines = (/** @type {string} */ t) => t.split("\n");
    const changed = (/** @type {string} */ a, /** @type {string} */ b) =>
      lines(a).filter((l, i) => l !== lines(b)[i]).length;
    assert.equal(lines(out.thirdParty).length, lines(DOCS.thirdParty).length);
    assert.equal(changed(DOCS.thirdParty, out.thirdParty), 2, "the SAM 3 bullet and the sources row");
    assert.equal(changed(DOCS.notice, out.notice), 1);
  });
  it("keeps the date when only the text changed", () => {
    const out = updateReferences(DOCS, OLD, { ...NEXT, date: OLD.date });
    assert.equal(out.notice, DOCS.notice);
    assert.ok(out.thirdParty.includes(`"Last Updated: ${OLD.date}"`));
  });
  it("throws when a reference is missing or repeated", () => {
    const noSha = { ...DOCS, thirdParty: DOCS.thirdParty.replace(OLD.sha256, "") };
    assert.throws(() => updateReferences(noSha, OLD, NEXT), /THIRD_PARTY\.md: expected one/);
    const twoDates = { ...DOCS, notice: `${DOCS.notice}\n"Last Updated: ${OLD.date}"\n` };
    assert.throws(() => updateReferences(twoDates, OLD, NEXT), /NOTICE: expected one .*found 2/);
    const noCommit = { ...DOCS, thirdParty: DOCS.thirdParty.replace(/file last changed in commit/, "changed in") };
    assert.throws(() => updateReferences(noCommit, OLD, NEXT), /THIRD_PARTY\.md: expected one/);
  });
});

describe("prBody", () => {
  it("links upstream, says what merging means, and fences the diff", () => {
    const body = prBody(OLD, NEXT, "-old\n+new\n");
    assert.match(body, /https:\/\/github\.com\/facebookresearch\/sam3\/commit\/0123456789abcdef/);
    assert.match(body, /https:\/\/github\.com\/facebookresearch\/sam3\/commits\/main\/LICENSE/);
    assert.match(body, /Merging this accepts the new terms on behalf of the project/);
    assert.match(body, /asks every user to agree again/);
    assert.ok(body.includes("```diff\n-old\n+new\n```"));
    assert.ok(prBody(OLD, NEXT, "+```\n").includes("~~~~diff\n+```\n~~~~"));
  });
});
