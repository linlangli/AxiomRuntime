#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildHomebrewFormula,
  captureCommand,
  commandExists,
  fetchNpmRelease,
  nextVersion,
  readGitHubRepository,
  readHomebrewFormula,
  runCommand,
  versionExistsOnNpm
} from "./release-support.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(projectRoot, "package.json");
const formulaRelativePath = path.join("Formula", "axiomruntime.rb");
const githubRepository = "linlangli/AxiomRuntime";
const githubProjectUrl = `https://github.com/${githubRepository}`;
const npmTrustedPublisherUrl = "https://www.npmjs.com/package/@offerpilot/axiomruntime/access";
const githubSshKeysUrl = "https://github.com/settings/keys";
const nodeDownloadUrl = "https://nodejs.org/zh-cn/download";
const rl = readline.createInterface({ input, output });

async function main() {
  const requestedAction = readRequestedAction(process.argv.slice(2));
  if (requestedAction) {
    await runAction(requestedAction);
    return;
  }

  console.log("\nAxiomRuntime 发布助手");
  console.log("=====================");
  while (true) {
    const action = await choose("请选择要做的事情", [
      ["npm", "发布新版本到 npm"],
      ["homebrew", "把 npm 最新版本发布到 Homebrew Tap"],
      ["check", "检查 npm / Homebrew 发布条件和当前状态"],
      ["exit", "退出"]
    ]);
    if (action === "exit") return;

    try {
      await runAction(action);
    } catch (error) {
      console.error(`\n操作未完成：${formatError(error)}`);
    }
    console.log("");
    await rl.question("按回车键返回主菜单...");
  }
}

function readRequestedAction(args) {
  if (args.includes("--npm") || args.includes("--current")) return "npm";
  if (args.includes("--homebrew")) return "homebrew";
  if (args.includes("--check")) return "check";
  return null;
}

async function runAction(action) {
  if (action === "npm") await publishNpm();
  if (action === "homebrew") await publishHomebrew();
  if (action === "check") await checkReleaseStatus();
}

async function publishNpm() {
  console.log("\n[1/5] 检查 npm 发布条件");
  await ensureBaseTools();
  await ensureCleanWorkingTree();
  await ensureGitHubReadyForNpm();

  const sourceBranch = await captureCommand("git", ["branch", "--show-current"], { cwd: projectRoot });
  const sourceCommit = await captureCommand("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
  console.log(`来源：${sourceBranch || "detached HEAD"} / ${sourceCommit.slice(0, 8)}`);
  console.log("助手会在临时目录合入远端 main、运行完整测试、创建中文 release commit 和 tag，再原子推送。当前工作目录不会切换分支。");
  if (!await confirm("确认开始准备 npm 发布？")) {
    console.log("已取消。");
    return;
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "axiomruntime-npm-release-"));
  try {
    const originUrl = await captureCommand("git", ["remote", "get-url", "--push", "origin"], { cwd: projectRoot });
    console.log("\n[2/5] 合并当前开发内容到临时 main");
    await cloneRemoteMain(originUrl, temporaryDirectory);
    await configureGitIdentity(temporaryDirectory);
    await ensureRemotePushAccess(temporaryDirectory);
    await runCommand("git", ["fetch", "--quiet", projectRoot, sourceCommit], { cwd: temporaryDirectory });
    const alreadyMerged = await commandSucceeds("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], temporaryDirectory);
    if (!alreadyMerged) {
      try {
        await runCommand("git", [
          "merge",
          "--no-ff",
          "FETCH_HEAD",
          "-m",
          `chore(release): 合并 ${sourceBranch || "当前提交"} 准备 npm 发布`
        ], { cwd: temporaryDirectory });
      } catch {
        throw new Error("当前开发内容与远端 main 存在合并冲突。请让 Codex 帮你合并 main 并解决冲突，然后重新打开发布助手。");
      }
    }

    console.log("\n[3/5] 设置版本并执行发布校验");
    const mergedPackage = JSON.parse(await fs.readFile(path.join(temporaryDirectory, "package.json"), "utf8"));
    const currentPublished = await versionExistsOnNpm(mergedPackage.name, mergedPackage.version);
    const releaseChoice = await chooseNpmVersion(mergedPackage.version, currentPublished);
    const releaseVersion = releaseChoice === "current"
      ? mergedPackage.version
      : nextVersion(mergedPackage.version, releaseChoice);
    console.log(`\n将发布：${mergedPackage.name}@${releaseVersion}`);
    if (releaseChoice !== "current") {
      await runCommand("npm", ["version", releaseChoice, "--no-git-tag-version"], { cwd: temporaryDirectory });
    }
    const preparedPackage = JSON.parse(await fs.readFile(path.join(temporaryDirectory, "package.json"), "utf8"));
    if (preparedPackage.version !== releaseVersion) {
      throw new Error(`版本准备结果不一致：预期 ${releaseVersion}，实际 ${preparedPackage.version}。`);
    }
    if (await versionExistsOnNpm(preparedPackage.name, releaseVersion)) {
      throw new Error(`${preparedPackage.name}@${releaseVersion} 已存在于 npm，不能重复发布。请重新选择版本。`);
    }
    await ensureRemoteTagAbsent(`v${releaseVersion}`);
    await runCommand("npm", ["ci", "--prefer-offline"], { cwd: temporaryDirectory });
    await runCommand("npm", ["--prefix", "web", "ci", "--prefer-offline"], { cwd: temporaryDirectory });
    await runCommand("npm", ["test"], { cwd: temporaryDirectory });
    await runCommand("npm", ["--prefix", "web", "run", "typecheck"], { cwd: temporaryDirectory });
    await runCommand("npm", ["pack", "--dry-run"], { cwd: temporaryDirectory });

    console.log("\n[4/5] 创建 release commit 和 tag");
    await runCommand("git", ["add", "package.json", "package-lock.json"], { cwd: temporaryDirectory });
    await runCommand("git", ["commit", "--allow-empty", "-m", `chore(release): 发布 npm v${releaseVersion}`], { cwd: temporaryDirectory });
    await runCommand("git", ["tag", `v${releaseVersion}`], { cwd: temporaryDirectory });
    await runCommand("git", ["status", "--short", "--branch"], { cwd: temporaryDirectory });

    if (!await confirm(`校验全部通过。确认推送 main 和 v${releaseVersion}，触发 GitHub Actions npm 发布？`)) {
      console.log("已取消推送；临时发布内容不会影响仓库。");
      return;
    }

    console.log("\n[5/5] 推送并启动 npm 发布流水线");
    await runCommand("git", ["push", "--atomic", "origin", "HEAD:main", `refs/tags/v${releaseVersion}`], { cwd: temporaryDirectory });
    const releaseCommit = await captureCommand("git", ["rev-parse", "HEAD"], { cwd: temporaryDirectory });
    const pipelineUrl = await waitForGitHubWorkflow(`v${releaseVersion}`, releaseCommit);
    console.log(`npm ${releaseVersion} 已发布成功：${pipelineUrl}`);
    console.log("如需同步 Homebrew，再次打开本助手并选择 Homebrew；助手会自动读取 npm Registry 的最新版本。");
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function publishHomebrew() {
  console.log("\n[1/4] 读取 npm Registry 最新版本");
  await ensureBaseTools();
  const packageJson = await readPackageJson();
  const npmRelease = await fetchNpmRelease(packageJson.name, "latest");
  const originUrl = await captureCommand("git", ["remote", "get-url", "--push", "origin"], { cwd: projectRoot });
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "axiomruntime-homebrew-release-"));

  try {
    console.log("\n[2/4] 检查 Homebrew Tap 当前状态");
    await cloneRemoteMain(originUrl, temporaryDirectory);
    await configureGitIdentity(temporaryDirectory);
    await ensureRemotePushAccess(temporaryDirectory);
    const formulaPath = path.join(temporaryDirectory, formulaRelativePath);
    const currentFormula = await fs.readFile(formulaPath, "utf8");
    const expectedFormula = buildHomebrewFormula(currentFormula, {
      homepage: githubProjectUrl,
      tarballUrl: npmRelease.tarballUrl,
      sha256: npmRelease.sha256
    });

    console.log(`npm 最新版本：${packageJson.name}@${npmRelease.version}`);
    console.log(`npm SHA256：${npmRelease.sha256}`);
    if (currentFormula === expectedFormula) {
      console.log("Homebrew Tap 已经发布此版本，无需重复操作。");
      return;
    }

    console.log("\n[3/4] 生成并校验 Formula");
    await fs.writeFile(formulaPath, expectedFormula, "utf8");
    if (commandExists("ruby")) {
      await runCommand("ruby", ["-c", formulaPath], { cwd: temporaryDirectory });
    } else {
      console.log("提示：本机未安装 Ruby，已跳过语法检查；远端 tarball 和 SHA256 仍已校验。");
    }
    await runCommand("git", ["diff", "--", formulaRelativePath], { cwd: temporaryDirectory });

    if (!await confirm(`确认把 npm ${npmRelease.version} 发布到 Homebrew Tap？`)) {
      console.log("已取消。");
      return;
    }

    console.log("\n[4/4] 提交并推送 Homebrew Formula");
    await runCommand("git", ["add", formulaRelativePath], { cwd: temporaryDirectory });
    await runCommand("git", ["commit", "-m", `chore(release): 发布 Homebrew v${npmRelease.version}`], { cwd: temporaryDirectory });
    await runCommand("git", ["push", "origin", "HEAD:main"], { cwd: temporaryDirectory });
    console.log(`Homebrew ${npmRelease.version} 已发布。`);
    console.log(`安装入口：brew tap linlangli/axiom ${githubProjectUrl}.git`);
    console.log("然后执行：brew install linlangli/axiom/axiomruntime");
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function checkReleaseStatus() {
  console.log("\n正在检查发布环境...");
  await ensureBaseTools();
  const packageJson = await readPackageJson();
  const status = await captureCommand("git", ["status", "--short"], { cwd: projectRoot });
  const remoteMain = await captureCommand("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: projectRoot }).catch(() => "");
  const npmRelease = await fetchNpmRelease(packageJson.name, "latest");
  const remoteFormula = remoteMain ? await readRemoteFormula().catch(() => "") : "";
  const homebrewRelease = readHomebrewFormula(remoteFormula);
  const githubReady = commandExists("gh") && await commandSucceeds("gh", ["auth", "status"], projectRoot);
  const workflowReady = githubReady && await commandSucceeds("gh", [
    "api", `repos/${githubRepository}/actions/workflows/publish.yml`
  ], projectRoot);

  console.log(`\nGit 工作区：${status ? "有未提交修改，发布 npm 前需要先提交" : "干净"}`);
  console.log(`远端 main：${remoteMain ? "可访问" : "不可访问"}`);
  console.log(`GitHub 登录：${githubReady ? "已就绪" : "未就绪"}`);
  console.log(`GitHub npm workflow：${workflowReady ? "已配置" : "未确认或未配置"}`);
  console.log(`npm 发布认证：GitHub OIDC，无需 NPM_TOKEN；Trusted Publisher 设置：${npmTrustedPublisherUrl}`);
  console.log(`npm 最新版本：${npmRelease.version}`);
  console.log(`Homebrew Tap：${!remoteFormula
    ? "无法读取"
    : homebrewRelease.tarballUrl === npmRelease.tarballUrl && homebrewRelease.sha256 === npmRelease.sha256
      ? `已发布 ${npmRelease.version}`
      : `未同步 npm ${npmRelease.version}`}`);

  if (!githubReady) await guideGitHubLogin();
  if (!remoteMain) await guideGitRemoteAccess();
}

async function ensureCleanWorkingTree() {
  const status = await captureCommand("git", ["status", "--short"], { cwd: projectRoot });
  if (!status) return;
  console.log("\n检测到未提交修改：");
  console.log(status);
  throw new Error("发布 npm 前必须先提交这些修改。请先让 Codex 帮你提交，然后重新双击“发布.command”。");
}

async function ensureBaseTools() {
  const missing = ["git", "npm"].filter((command) => !commandExists(command));
  if (missing.length) {
    await guideBaseTools(missing);
    throw new Error(`缺少发布工具：${missing.join("、")}。请先安装 Node.js 22.19.0+ 和 Git。`);
  }
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
  if (!supported) {
    if (await confirm("Node.js 版本过低。现在打开下载页面？")) await openUrl(nodeDownloadUrl);
    throw new Error(`当前 Node.js 为 ${process.versions.node}，需要 22.19.0 或更高版本。`);
  }
  const originUrl = await captureCommand("git", ["remote", "get-url", "--push", "origin"], { cwd: projectRoot });
  if (readGitHubRepository(originUrl)?.toLowerCase() !== githubRepository.toLowerCase()) {
    throw new Error(`请先把 origin 指向 git@github.com:${githubRepository}.git，并迁移 main 分支与 tags。`);
  }
}

async function guideBaseTools(missing) {
  if (missing.includes("git") && process.platform === "darwin" && await confirm("未找到 Git。现在启动 macOS 开发者工具安装？")) {
    await runCommand("/usr/bin/xcode-select", ["--install"]).catch(() => undefined);
  }
  if (missing.includes("npm") && await confirm("未找到 npm。现在打开 Node.js 下载页面？")) {
    await openUrl(nodeDownloadUrl);
  }
}

async function cloneRemoteMain(originUrl, temporaryDirectory) {
  try {
    await runCommand("git", ["clone", "--quiet", "--branch", "main", "--single-branch", originUrl, temporaryDirectory], { cwd: projectRoot });
  } catch {
    await guideGitRemoteAccess();
    throw new Error("无法读取 GitHub main 分支。请完成远端访问设置后重新打开发布助手。");
  }
}

async function ensureRemotePushAccess(cwd) {
  try {
    await runCommand("git", ["push", "--dry-run", "origin", "HEAD:main"], { cwd });
  } catch {
    await guideGitRemoteAccess();
    throw new Error("当前 Git 身份没有推送 main 的权限。请完成 GitHub SSH 设置后重试。");
  }
}

async function ensureRemoteTagAbsent(tag) {
  const existing = await captureCommand("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: projectRoot });
  if (!existing) return;
  const pipelinesUrl = `${githubProjectUrl}/actions/workflows/publish.yml`;
  if (await confirm(`${tag} 已存在，但 npm 中没有对应版本。现在打开 GitHub Actions 检查失败原因？`)) {
    await openUrl(pipelinesUrl);
  }
  throw new Error(`${tag} 已存在，不能重复创建。请先处理已有 tag 的 npm 发布流水线。`);
}

async function guideGitRemoteAccess() {
  console.log("\n需要可读写 GitHub 仓库的 Git 身份。发布助手不会要求你输入或保存私钥。");
  if (await confirm("现在打开 GitHub SSH Keys 设置页面？")) await openUrl(githubSshKeysUrl);
}

async function waitForGitHubWorkflow(tag, commit) {
  console.log("正在等待 GitHub Actions 返回 npm 发布结果...");
  let lastStatus = "";
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const output = await captureCommand("gh", [
      "run",
      "list",
      "--repo",
      githubRepository,
      "--workflow",
      "publish.yml",
      "--branch",
      tag,
      "--commit",
      commit,
      "--event",
      "push",
      "--limit",
      "1",
      "--json",
      "status,conclusion,url"
    ], { cwd: projectRoot }).catch(() => "[]");
    const pipelines = JSON.parse(output || "[]");
    const pipeline = pipelines[0];
    if (!pipeline) {
      if (attempt === 0) console.log("流水线正在创建...");
    } else {
      const status = pipeline.conclusion || pipeline.status;
      if (status !== lastStatus) {
        console.log(`GitHub Actions 状态：${status}`);
        lastStatus = status;
      }
      if (pipeline.status === "completed") {
        if (pipeline.conclusion === "success") return pipeline.url;
        throw new Error(`npm 发布流水线 ${status}：${pipeline.url}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`等待 npm 发布超时，请打开 GitHub Actions 查看：${githubProjectUrl}/actions/workflows/publish.yml`);
}

async function ensureGitHubReadyForNpm() {
  if (!commandExists("gh")) {
    await guideGhInstall();
    throw new Error("GitHub CLI 尚未就绪。安装完成后重新打开发布助手。");
  }
  if (!await commandSucceeds("gh", ["auth", "status"], projectRoot)) {
    await guideGitHubLogin();
    throw new Error("GitHub 尚未登录。登录完成后重新打开发布助手。");
  }
  const workflow = JSON.parse(await captureCommand("gh", [
    "api", `repos/${githubRepository}/actions/workflows/publish.yml`
  ], { cwd: projectRoot }));
  if (workflow.state !== "active") {
    throw new Error(`请先启用 GitHub Actions publish.yml：${githubProjectUrl}/actions/workflows/publish.yml`);
  }
  console.log(`npm 使用 GitHub OIDC；Trusted Publisher 必须匹配 ${githubRepository} / publish.yml / npm-production。`);
  console.log(`npm 设置：${npmTrustedPublisherUrl}`);
}

async function guideGhInstall() {
  console.log("\n需要 GitHub CLI 来检查登录、发布 workflow 和 Actions 结果。");
  if (process.platform === "darwin" && commandExists("brew") && await confirm("现在自动安装 GitHub CLI？")) {
    await runCommand("brew", ["install", "gh"], { cwd: projectRoot });
    return;
  }
  console.log("请安装 GitHub CLI：https://cli.github.com/");
}

async function guideGitHubLogin() {
  console.log("\n需要登录有仓库权限的 GitHub 账号。发布助手可以替你启动登录向导。");
  if (commandExists("gh") && await confirm("现在启动 GitHub 登录向导？")) {
    await runCommand("gh", ["auth", "login", "--hostname", "github.com"], { cwd: projectRoot });
  }
}

async function chooseNpmVersion(currentVersion, currentPublished) {
  const choices = currentPublished
    ? [
      ["patch", `补丁版本 ${nextVersion(currentVersion, "patch")}（推荐）`],
      ["minor", `功能版本 ${nextVersion(currentVersion, "minor")}`],
      ["major", `重大版本 ${nextVersion(currentVersion, "major")}`]
    ]
    : [
      ["current", `发布当前版本 ${currentVersion}（推荐）`],
      ["patch", `改为补丁版本 ${nextVersion(currentVersion, "patch")}`],
      ["minor", `改为功能版本 ${nextVersion(currentVersion, "minor")}`],
      ["major", `改为重大版本 ${nextVersion(currentVersion, "major")}`]
    ];
  return choose(currentPublished ? `${currentVersion} 已发布，请选择新版本类型` : "请选择版本", choices);
}

async function readPackageJson() {
  return JSON.parse(await fs.readFile(packagePath, "utf8"));
}

async function readRemoteFormula() {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "axiomruntime-release-check-"));
  try {
    const originUrl = await captureCommand("git", ["remote", "get-url", "origin"], { cwd: projectRoot });
    await cloneRemoteMain(originUrl, temporaryDirectory);
    return fs.readFile(path.join(temporaryDirectory, formulaRelativePath), "utf8");
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function configureGitIdentity(cwd) {
  const name = await captureCommand("git", ["config", "user.name"], { cwd: projectRoot }).catch(() => "Axiom Runtime Release");
  const email = await captureCommand("git", ["config", "user.email"], { cwd: projectRoot }).catch(() => "release@offerpilot.local");
  await runCommand("git", ["config", "user.name", name || "Axiom Runtime Release"], { cwd });
  await runCommand("git", ["config", "user.email", email || "release@offerpilot.local"], { cwd });
}

async function choose(message, choices) {
  console.log(`\n${message}`);
  choices.forEach(([, label], index) => console.log(`  ${index + 1}. ${label}`));
  while (true) {
    const answer = Number(await rl.question("请输入序号："));
    if (Number.isInteger(answer) && answer >= 1 && answer <= choices.length) {
      return choices[answer - 1][0];
    }
    console.log(`请输入 1-${choices.length}。`);
  }
}

async function confirm(message) {
  const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function openUrl(url) {
  if (process.platform === "darwin") return runCommand("/usr/bin/open", [url]);
  if (process.platform === "win32") return runCommand("cmd", ["/c", "start", "", url]);
  if (commandExists("xdg-open")) return runCommand("xdg-open", [url]);
  console.log(url);
}

function commandSucceeds(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(`\n错误：${formatError(error)}`);
  process.exitCode = 1;
}).finally(() => rl.close());
