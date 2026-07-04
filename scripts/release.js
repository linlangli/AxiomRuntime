#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

async function main() {
  try {
    await ensureCleanGit();
    const currentVersion = await npm(["pkg", "get", "version"], { capture: true });
    console.log(`Current version: ${JSON.parse(currentVersion.trim())}`);

    const bump = await choose("Select version bump", [
      ["patch", "bug fix, small improvement"],
      ["minor", "new feature, backward compatible"],
      ["major", "breaking change"]
    ]);

    await run("npm", ["test"]);
    await run("npm", ["version", bump]);
    const nextVersion = JSON.parse((await npm(["pkg", "get", "version"], { capture: true })).trim());
    console.log(`Next version: ${nextVersion}`);

    await run("npm", ["pack", "--dry-run"]);
    const publish = await confirm("Publish to npm now?");
    if (!publish) {
      console.log("Skipped npm publish. Version commit/tag has been created by `npm version`.");
      return;
    }

    await run("npm", ["publish", "--access", "public"]);
    console.log(`Published ${nextVersion}.`);
  } finally {
    rl.close();
  }
}

async function ensureCleanGit() {
  const status = await run("git", ["status", "--short"], { capture: true });
  if (status.trim()) {
    throw new Error("Git working tree is not clean. Commit or stash changes before release.");
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

async function confirm(message) {
  const answer = (await rl.question(`${message} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
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
