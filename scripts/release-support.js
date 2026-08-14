import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export function nextVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`不支持的版本号：${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  throw new Error(`不支持的版本类型：${bump}`);
}

export function readHomebrewFormula(source) {
  return {
    homepage: /^  homepage "(.*)"$/m.exec(source)?.[1] ?? null,
    tarballUrl: /^  url "(.*)"$/m.exec(source)?.[1] ?? null,
    sha256: /^  sha256 "(.*)"$/m.exec(source)?.[1] ?? null
  };
}

export function buildHomebrewFormula(source, release) {
  const current = readHomebrewFormula(source);
  if (!current.homepage || !current.tarballUrl || !current.sha256) {
    throw new Error("Homebrew Formula 缺少 homepage、url 或 sha256 字段。");
  }
  return source
    .replace(/^  homepage ".*"$/m, `  homepage "${release.homepage}"`)
    .replace(/^  url ".*"$/m, `  url "${release.tarballUrl}"`)
    .replace(/^  sha256 ".*"$/m, `  sha256 "${release.sha256}"`);
}

export async function fetchNpmRelease(packageName, version) {
  const packagePath = packageName.replace("/", "%2F");
  const metadataUrl = `https://registry.npmjs.org/${packagePath}/${encodeURIComponent(version)}`;
  const metadataResponse = await fetch(metadataUrl, { headers: { accept: "application/json" } });
  if (!metadataResponse.ok) {
    throw new Error(`npm Registry 中找不到 ${packageName}@${version}（HTTP ${metadataResponse.status}）。请先发布 npm。`);
  }
  const metadata = await metadataResponse.json();
  const tarballUrl = metadata?.dist?.tarball;
  if (typeof metadata?.version !== "string" || typeof tarballUrl !== "string") {
    throw new Error("npm Registry 返回的版本信息不完整。");
  }
  const parsedTarballUrl = new URL(tarballUrl);
  if (parsedTarballUrl.protocol !== "https:" || parsedTarballUrl.hostname !== "registry.npmjs.org") {
    throw new Error(`npm Registry 返回了不可信的 tarball 地址：${tarballUrl}`);
  }
  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    throw new Error(`下载 npm tarball 失败（HTTP ${tarballResponse.status}）。`);
  }
  const tarball = Buffer.from(await tarballResponse.arrayBuffer());
  return {
    version: metadata.version,
    tarballUrl,
    sha256: createHash("sha256").update(tarball).digest("hex")
  };
}

export async function versionExistsOnNpm(packageName, version) {
  const packagePath = packageName.replace("/", "%2F");
  const response = await fetch(`https://registry.npmjs.org/${packagePath}/${encodeURIComponent(version)}`, {
    method: "HEAD"
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`检查 npm 版本失败（HTTP ${response.status}）。`);
  return true;
}

export function commandExists(command) {
  return spawnSync("/usr/bin/env", ["sh", "-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    stdio: "ignore"
  }).status === 0;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`${command} 被 ${signal} 中断。`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} 执行失败（退出码 ${code}）。`));
    });
  });
}

export function captureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`${command} 被 ${signal} 中断。`));
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} 执行失败（退出码 ${code}）。`));
    });
  });
}
