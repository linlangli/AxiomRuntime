import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { RunToolType } from "../types.js";

export function resolveToolCommand(tool: RunToolType): string | null {
  return resolveToolCommandWithOptions(tool);
}

export function resolveToolCommandWithOptions(
  tool: RunToolType,
  options: {
    pathResolver?: (command: string) => string | null;
    candidates?: string[];
    runner?: (command: string) => boolean;
  } = {}
): string | null {
  const command = tool === "claude" ? "claude" : "codex";
  const runner = options.runner ?? isRunnableCommand;
  const fromPath = (options.pathResolver ?? resolveFromPath)(command);
  if (fromPath && runner(fromPath)) return fromPath;

  for (const candidate of options.candidates ?? getKnownCandidates(tool)) {
    if (runner(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getKnownCandidates(tool: RunToolType): string[] {
  if (tool === "claude") {
    return [
      path.join(os.homedir(), ".local/bin/claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude"
    ];
  }

  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ];
}

function resolveFromPath(command: string): string | null {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout.trim();
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isRunnableCommand(command: string): boolean {
  if (!isExecutable(command)) return false;
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0;
}
