import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { RunToolType } from "../types.js";

export function resolveToolCommand(tool: RunToolType): string | null {
  const command = tool === "claude" ? "claude" : tool === "hermes" ? "hermes" : "codex";
  const fromPath = resolveFromPath(command);
  if (fromPath) return fromPath;

  for (const candidate of getKnownCandidates(tool)) {
    if (isExecutable(candidate)) {
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

  if (tool === "hermes") {
    return [
      path.join(os.homedir(), ".local/bin/hermes"),
      path.join(os.homedir(), ".hermes", "bin", "hermes"),
      "/opt/homebrew/bin/hermes",
      "/usr/local/bin/hermes"
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
