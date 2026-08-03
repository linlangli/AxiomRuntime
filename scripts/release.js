#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

async function main() {
  try {
    await ensureCleanGit();
    const currentVersion = JSON.parse((await npm(["pkg", "get", "version"], { capture: true })).trim());
    console.log(`Current version: ${currentVersion}`);

    if (process.argv.includes("--current")) {
      await ensureTagAbsent(currentVersion);
      await verifyRelease();
      await run("git", ["tag", `v${currentVersion}`]);
      console.log(`Prepared v${currentVersion}. Push the tag to let GitLab publish npm and Homebrew.`);
      return;
    }

    const bump = await choose("Select version bump", [
      ["patch", "bug fix, small improvement"],
      ["minor", "new feature, backward compatible"],
      ["major", "breaking change"]
    ]);

    await run("npm", ["version", bump, "--no-git-tag-version"]);
    const nextVersion = JSON.parse((await npm(["pkg", "get", "version"], { capture: true })).trim());
    console.log(`Next version: ${nextVersion}`);

    await run("npm", ["run", "homebrew:update"]);
    await ensureTagAbsent(nextVersion);
    await verifyRelease();
    await run("git", ["add", "package.json", "package-lock.json", "Formula/axiomruntime.rb"]);
    await run("git", ["commit", "-m", `chore(release): v${nextVersion}`]);
    await run("git", ["tag", `v${nextVersion}`]);
    console.log(`Prepared v${nextVersion}. Push the release commit and tag to let GitLab publish npm and Homebrew.`);
  } finally {
    rl.close();
  }
}

async function verifyRelease() {
  await run("npm", ["test"]);
  await run("npm", ["run", "homebrew:check"]);
  await run("npm", ["pack", "--dry-run"]);
}

async function ensureCleanGit() {
  const status = await run("git", ["status", "--short"], { capture: true });
  if (status.trim()) {
    throw new Error("Git working tree is not clean. Commit or stash changes before release.");
  }
}

async function ensureTagAbsent(version) {
  const tags = await run("git", ["tag", "--list", version, `v${version}`], { capture: true });
  if (tags.trim()) {
    throw new Error(`Release tag already exists: ${tags.trim().split("\n").join(", ")}`);
  }
}

async function choose(message, choices) {
  console.log(`\n${message}`);
  choices.forEach(([value, description], index) => {
    console.log(`  ${index + 1}. ${value} - ${description}`);
  });

  while (true) {
    const answer = await rl.question("Select: ");
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1][0];
    }
    console.log(`Please enter a number between 1 and ${choices.length}.`);
  }
}

async function npm(args, options = {}) {
  return run("npm", args, options);
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";

    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  rl.close();
});
