#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const formulaPath = path.join(projectRoot, "Formula", "axiomruntime.rb");
const packagePath = path.join(projectRoot, "package.json");

async function main() {
  const write = process.argv.includes("--write");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (packageJson.name !== "@offerpilot/axiomruntime") {
    throw new Error(`Unexpected package name: ${packageJson.name}`);
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "axiomruntime-pack-"));
  try {
    const packOutput = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory]);
    const packResult = JSON.parse(packOutput)[0];
    if (!packResult?.filename) throw new Error("npm pack did not return a filename.");

    const tarballPath = path.join(temporaryDirectory, packResult.filename);
    const sha256 = createHash("sha256").update(await fs.readFile(tarballPath)).digest("hex");
    const url = `https://registry.npmjs.org/@offerpilot/axiomruntime/-/axiomruntime-${packageJson.version}.tgz`;
    const currentFormula = await fs.readFile(formulaPath, "utf8");
    const expectedFormula = currentFormula
      .replace(/^  url ".*"$/m, `  url "${url}"`)
      .replace(/^  sha256 ".*"$/m, `  sha256 "${sha256}"`);

    if (write) {
      await fs.writeFile(formulaPath, expectedFormula, "utf8");
      console.log(`Updated Formula/axiomruntime.rb for ${packageJson.version} (${sha256}).`);
      return;
    }

    if (currentFormula !== expectedFormula) {
      throw new Error("Homebrew Formula URL or SHA256 is stale. Run `npm run homebrew:update`.");
    }
    console.log(`Homebrew Formula matches ${packageJson.name}@${packageJson.version} (${sha256}).`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
