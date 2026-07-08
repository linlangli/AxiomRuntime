import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getContextPathForRoot, getProjectRoot } from "../config/paths.js";
import { readRecentLogs } from "../logs/log-service.js";

const execFileAsync = promisify(execFile);

const EXCLUDED_DIRS = new Set([
  ".git",
  ".ai-gateway",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache"
]);

const EXCLUDED_FILES = new Set([
  "providers.json",
  ".ai-cache.json",
  "usage.json",
  ".ai-gateway.log",
  ".DS_Store",
  ".env"
]);

const DOC_CANDIDATES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/SPEC.md",
  "docs/CONVENTIONS.md",
  "docs/USAGE.md"
];

export type ProjectContext = {
  filePath: string;
  content: string;
};

export async function generateProjectContext(root = getProjectRoot()): Promise<ProjectContext> {
  const content = [
    "# AI Gateway Project Context",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Project root: ${root}`,
    "",
    await renderGitSection(root),
    await renderPackageSection(root),
    await renderFileTree(root),
    await renderDocsSection(root),
    await renderLogsSection()
  ].join("\n");

  const filePath = getContextPathForRoot(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${content.trim()}\n`, "utf8");
  return { filePath, content: `${content.trim()}\n` };
}

async function renderGitSection(root: string): Promise<string> {
  const [branch, status, diffStat, latestCommit] = await Promise.all([
    runGit(root, ["branch", "--show-current"]),
    runGit(root, ["status", "--short"]),
    runGit(root, ["diff", "--stat"]),
    runGit(root, ["log", "-1", "--oneline"])
  ]);

  return [
    "## Git",
    "",
    `Branch: ${branch || "(unknown)"}`,
    `Latest commit: ${latestCommit || "(none)"}`,
    "",
    "### Status",
    "",
    fenced(status || "clean"),
    "",
    "### Diff Stat",
    "",
    fenced(diffStat || "no working tree diff")
  ].join("\n");
}

async function renderPackageSection(root: string): Promise<string> {
  const packagePath = path.join(root, "package.json");
  try {
    const pkg = JSON.parse(await fs.readFile(packagePath, "utf8")) as {
      name?: string;
      version?: string;
      type?: string;
      scripts?: Record<string, string>;
    };
    const scripts = Object.entries(pkg.scripts ?? {})
      .map(([name, script]) => `- ${name}: ${script}`)
      .join("\n") || "- none";

    return [
      "## Project",
      "",
      `Name: ${pkg.name ?? "(unknown)"}`,
      `Version: ${pkg.version ?? "(unknown)"}`,
      `Type: ${pkg.type ?? "(unknown)"}`,
      "",
      "### Scripts",
      "",
      scripts
    ].join("\n");
  } catch {
    return ["## Project", "", "No package.json detected."].join("\n");
  }
}

async function renderFileTree(root: string): Promise<string> {
  const entries = await collectTree(root, root, 0, 3, 180);
  return [
    "## File Tree",
    "",
    "Excluded: node_modules, dist, build, .git, .ai-gateway, env/key/cache files.",
    "",
    fenced(entries.join("\n") || "(empty)")
  ].join("\n");
}

async function renderDocsSection(root: string): Promise<string> {
  const sections: string[] = ["## Key Documents", ""];
  for (const relativePath of DOC_CANDIDATES) {
    const absolutePath = path.join(root, relativePath);
    const text = await readTextIfExists(absolutePath);
    if (!text) continue;
    sections.push(`### ${relativePath}`, "", truncate(text, 1600), "");
  }
  if (sections.length === 2) {
    sections.push("No key documents found.");
  }
  return sections.join("\n").trimEnd();
}

async function renderLogsSection(): Promise<string> {
  const logs = await readRecentLogs(10);
  return [
    "## Recent AI Gateway Logs",
    "",
    logs.length
      ? logs.map((event) => `- ${event.timestamp} [${event.level}] ${event.category}/${event.action}: ${event.message}`).join("\n")
      : "No logs found."
  ].join("\n");
}

async function collectTree(root: string, current: string, depth: number, maxDepth: number, maxEntries: number, state = { count: 0 }): Promise<string[]> {
  if (depth > maxDepth || state.count >= maxEntries) return [];
  const dirents = await fs.readdir(current, { withFileTypes: true });
  const lines: string[] = [];

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.count >= maxEntries) break;
    if (shouldExclude(dirent.name)) continue;

    const absolutePath = path.join(current, dirent.name);
    const relativePath = path.relative(root, absolutePath);
    lines.push(`${"  ".repeat(depth)}${dirent.isDirectory() ? "+ " : "- "}${relativePath}`);
    state.count += 1;

    if (dirent.isDirectory()) {
      lines.push(...await collectTree(root, absolutePath, depth + 1, maxDepth, maxEntries, state));
    }
  }

  return lines;
}

function shouldExclude(name: string): boolean {
  if (EXCLUDED_DIRS.has(name) || EXCLUDED_FILES.has(name)) return true;
  if (name.endsWith(".log")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12")) return true;
  return false;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n\n... truncated ...`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
