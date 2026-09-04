import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReviewGitPort } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_COMMIT_BYTES = 1_500_000;

export class LocalReviewGit implements ReviewGitPort {
  async getRepositoryRoot(cwd: string): Promise<string> {
    return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  }

  async assertClean(cwd: string): Promise<void> {
    const status = await this.readStatus(cwd);
    if (status.trim()) {
      throw new Error([
        "审阅要求 Git 工作区干净，以免自动提交包含无关改动。",
        status,
        "请在运行 `ai review` 前提交、暂存或丢弃这些改动。"
      ].join("\n"));
    }
  }

  async resolveCommit(cwd: string, target: string): Promise<string> {
    try {
      return (await runGit(cwd, ["rev-parse", "--verify", `${target}^{commit}`])).trim();
    } catch {
      throw new Error(`找不到 Git commit 或 ref：${target}`);
    }
  }

  async readCommit(cwd: string, commit: string): Promise<string> {
    try {
      return await runGit(cwd, [
        "show",
        "--no-ext-diff",
        "--find-renames",
        "--find-copies",
        "--format=fuller",
        "--stat",
        "--patch",
        commit
      ], MAX_COMMIT_BYTES);
    } catch (error) {
      if (isMaxBufferError(error)) {
        throw new Error(`提交 ${commit.slice(0, 12)} 过大，无法自动审阅（上限 ${MAX_COMMIT_BYTES} 字节）。`);
      }
      throw error;
    }
  }

  async readStatus(cwd: string): Promise<string> {
    return runGit(cwd, ["status", "--short", "--untracked-files=all"]);
  }

  async commitAll(cwd: string, subject: string, body: string): Promise<string> {
    const status = await this.readStatus(cwd);
    if (!status.trim()) {
      throw new Error("修复模型没有修改任何文件。");
    }
    await runGit(cwd, ["diff", "--check"]);
    await runGit(cwd, ["add", "--all"]);
    await runGit(cwd, ["diff", "--cached", "--check"]);
    await runGit(cwd, ["commit", "-m", subject, "-m", body]);
    return (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
  }
}

async function runGit(cwd: string, args: string[], maxBuffer = 10 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer
    });
    return stdout;
  } catch (error) {
    if (isMaxBufferError(error)) throw error;
    const stderr = readErrorText(error);
    throw new Error(stderr || `git ${args[0] ?? "command"} failed.`);
  }
}

function readErrorText(error: unknown): string {
  if (!isRecord(error)) return error instanceof Error ? error.message : String(error);
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr || (error instanceof Error ? error.message : String(error));
}

function isMaxBufferError(error: unknown): boolean {
  return isRecord(error) && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
