#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHomebrewFormula, fetchNpmRelease } from "./release-support.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const formulaPath = path.join(projectRoot, "Formula", "axiomruntime.rb");
const packagePath = path.join(projectRoot, "package.json");

async function main() {
  const write = process.argv.includes("--write");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (packageJson.name !== "@offerpilot/axiomruntime") {
    throw new Error(`Unexpected package name: ${packageJson.name}`);
  }

  const release = await fetchNpmRelease(packageJson.name, packageJson.version);
  const currentFormula = await fs.readFile(formulaPath, "utf8");
  const expectedFormula = buildHomebrewFormula(currentFormula, {
    homepage: "https://github.com/linlangli/AxiomRuntime",
    tarballUrl: release.tarballUrl,
    sha256: release.sha256
  });

  if (write) {
    await fs.writeFile(formulaPath, expectedFormula, "utf8");
    console.log(`已按 npm Registry 更新 Formula/axiomruntime.rb：${release.version} (${release.sha256})`);
    return;
  }
  if (currentFormula !== expectedFormula) {
    throw new Error("Homebrew Formula 与 npm Registry 不一致。请打开发布助手并选择 Homebrew。");
  }
  console.log(`Homebrew Formula 与 ${packageJson.name}@${release.version} 一致 (${release.sha256})。`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
