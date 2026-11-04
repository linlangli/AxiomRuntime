import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deployScript = fileURLToPath(new URL("../scripts/deploy-portal.sh", import.meta.url));
const commitSha = "a".repeat(40);

function runDeployment(ciEnvironment, healthFailure = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-portal-test-"));
  const artifactDirectory = path.join(directory, "web/dist/portal");
  const binDirectory = path.join(directory, "bin");
  const logPath = path.join(directory, "commands.jsonl");
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(path.join(artifactDirectory, "index.html"), "<html>portal fixture</html>");
  const mockCommand = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stdin = command === "ssh" ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify({ command, args, stdin }) + "\\n");
if (command === "ssh" && stdin.includes("readlink")) console.log("releases/previous");
if (command === "curl") {
  if (process.env.DEPLOY_TEST_HEALTH_FAILURE === "1") process.exit(22);
  fs.copyFileSync("web/dist/portal/index.html", args[args.indexOf("--output") + 1]);
}
`;
  for (const command of ["ssh", "rsync", "curl"]) {
    fs.writeFileSync(path.join(binDirectory, command), mockCommand, { mode: 0o755 });
  }
  const environment = { ...process.env };
  for (const variable of ["CI_COMMIT_SHA", "CI_JOB_ID", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    delete environment[variable];
  }
  try {
    const result = spawnSync("bash", [deployScript], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...environment,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
        PORTAL_SSH_HOST: "portal.example.test",
        PORTAL_SSH_USER: "axiom-portal-deploy",
        PORTAL_SSH_PRIVATE_KEY_B64: Buffer.from("fixture key").toString("base64"),
        PORTAL_SSH_KNOWN_HOSTS: "portal.example.test ssh-ed25519 fixture",
        PORTAL_DEPLOY_ROOT: "/srv/axiomruntime-portal",
        PORTAL_HEALTH_URL: "https://portal.example.test/",
        DEPLOY_TEST_LOG: logPath,
        DEPLOY_TEST_HEALTH_FAILURE: healthFailure ? "1" : "0",
        ...ciEnvironment
      }
    });
    assert.ifError(result.error);
    const commands = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
    return { ...result, commands };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("门户部署保留 GitLab release 命名和 SSH 主机校验", () => {
  const result = runDeployment({ CI_COMMIT_SHA: commitSha, CI_JOB_ID: "123" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Portal release ${commitSha}-123 is live`));
  const upload = result.commands.find((command) => command.command === "rsync");
  assert.ok(upload.args.includes(`axiom-portal-deploy@portal.example.test:/srv/axiomruntime-portal/releases/${commitSha}-123/`));
  for (const command of result.commands.filter((entry) => entry.command === "ssh")) {
    assert.ok(command.args.includes("StrictHostKeyChecking=yes"));
  }
});

test("门户部署使用 GitHub run attempt 区分重跑", () => {
  for (const attempt of ["1", "2"]) {
    const result = runDeployment({ GITHUB_SHA: commitSha, GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: attempt });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Portal release ${commitSha}-456-${attempt} is live`));
  }
});

test("GitHub 门户健康检查失败时恢复上一 release", () => {
  const result = runDeployment({ GITHUB_SHA: commitSha, GITHUB_RUN_ID: "456" }, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restoring previous release/);
  const rollback = result.commands.at(-1);
  assert.equal(rollback.command, "ssh");
  assert.equal(rollback.args.at(-1), "releases/previous");
  assert.match(rollback.stdin, /\.current-rollback/);
});

test("无效的 GitHub 提交或 attempt 在连接服务器前被拒绝", () => {
  for (const environment of [
    { GITHUB_SHA: "invalid", GITHUB_RUN_ID: "456" },
    { GITHUB_SHA: commitSha, GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "../../invalid" }
  ]) {
    const result = runDeployment(environment);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid deployment path or commit SHA/);
    assert.deepEqual(result.commands, []);
  }
});

test("缺少部署密钥时不连接服务器", () => {
  const result = runDeployment({ GITHUB_SHA: commitSha, GITHUB_RUN_ID: "456", PORTAL_SSH_PRIVATE_KEY_B64: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PORTAL_SSH_PRIVATE_KEY_B64 is required/);
  assert.deepEqual(result.commands, []);
});
