import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHomebrewFormula,
  nextVersion,
  readHomebrewFormula
} from "../scripts/release-support.js";

test("发布助手计算 patch、minor 和 major 版本", () => {
  assert.equal(nextVersion("0.0.1", "patch"), "0.0.2");
  assert.equal(nextVersion("0.0.1", "minor"), "0.1.0");
  assert.equal(nextVersion("0.9.8", "major"), "1.0.0");
  assert.throws(() => nextVersion("v0.0.1", "patch"), /不支持的版本号/);
});

test("Homebrew Formula 只更新发布字段并保留安装逻辑", () => {
  const current = [
    "class Axiomruntime < Formula",
    "  homepage \"https://old.example.test\"",
    "  url \"https://registry.npmjs.org/old.tgz\"",
    "  sha256 \"old-sha\"",
    "",
    "  depends_on \"node@22\"",
    "end",
    ""
  ].join("\n");
  const release = {
    homepage: "https://gitlab.com/linlangli/axiom",
    tarballUrl: "https://registry.npmjs.org/@offerpilot/axiomruntime/-/axiomruntime-0.1.0.tgz",
    sha256: "abc123"
  };

  const updated = buildHomebrewFormula(current, release);

  assert.deepEqual(readHomebrewFormula(updated), release);
  assert.match(updated, /depends_on "node@22"/);
});

test("Homebrew Formula 缺少受管字段时拒绝发布", () => {
  assert.throws(
    () => buildHomebrewFormula("class Axiomruntime < Formula\nend\n", {
      homepage: "https://gitlab.com/linlangli/axiom",
      tarballUrl: "https://registry.npmjs.org/package.tgz",
      sha256: "abc123"
    }),
    /缺少 homepage、url 或 sha256/
  );
});
