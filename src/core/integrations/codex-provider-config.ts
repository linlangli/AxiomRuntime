import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { Provider } from "../types.js";
import { resolveToolCommand } from "../runner/command-resolver.js";
import { getRunnerEngine } from "../runner/engine-registry.js";

const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  update: 5_000,
  retries: {
    retries: 100,
    factor: 1.2,
    minTimeout: 25,
    maxTimeout: 500
  }
} satisfies lockfile.LockOptions;

const RESERVED_PROVIDER_IDS = new Set(["openai", "ollama", "lmstudio"]);
const CODEX_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
] as const;

export type CodexProviderSelection =
  | { type: "chatgpt" }
  | { type: "provider"; provider: Provider; model: string };

export type CodexAppRestartResult = {
  scheduled: boolean;
  appPath?: string;
  reason?: string;
};

export type SetCodexProviderResult = {
  selection: "chatgpt" | "provider";
  providerName: string;
  providerId: string;
  model: string | null;
  configPath: string;
  authPath: string;
  restart: CodexAppRestartResult;
};

export type CodexProxyEnvironmentResult = {
  applied: boolean;
  reason?: string;
};

export type SetCodexProxyResult = {
  proxyUrl: string | null;
  configPath: string;
  environment: CodexProxyEnvironmentResult;
  restart: CodexAppRestartResult;
};

type ChatGptLoginRunner = (input: { codexHome: string }) => Promise<number>;

export type SetCodexProviderOptions = {
  codexHome?: string;
  runChatGptLogin?: ChatGptLoginRunner;
  scheduleRestart?: () => Promise<CodexAppRestartResult>;
};

export type SetCodexProxyOptions = {
  codexHome?: string;
  platform?: NodeJS.Platform;
  applyProxyEnvironment?: (proxyUrl: string | null) => Promise<CodexProxyEnvironmentResult>;
  scheduleRestart?: () => Promise<CodexAppRestartResult>;
};

type SpawnDetachedOptions = {
  env?: NodeJS.ProcessEnv;
};

type FileSnapshot = {
  content: Buffer;
  mode: number;
} | null;

export async function setCodexProvider(
  selection: CodexProviderSelection,
  options: SetCodexProviderOptions = {}
): Promise<SetCodexProviderResult> {
  const codexHome = resolveCodexHome(options.codexHome);
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });

  const release = await lockfile.lock(configPath, LOCK_OPTIONS);
  let providerName: string;
  let providerId: string;
  let model: string | null;
  try {
    if (selection.type === "chatgpt") {
      providerName = "ChatGPT";
      providerId = "openai";
      model = null;
      await configureChatGpt(configPath, authPath, codexHome, options.runChatGptLogin);
    } else {
      providerName = selection.provider.name;
      providerId = providerIdForName(selection.provider.name);
      model = assertCodexGptModel(selection.model);
      await configureCustomProvider(configPath, authPath, selection.provider, providerId, model);
    }
  } finally {
    await release();
  }

  const restart = await (options.scheduleRestart ?? scheduleCodexAppRestart)();
  return {
    selection: selection.type,
    providerName,
    providerId,
    model,
    configPath,
    authPath,
    restart
  };
}

export async function setCodexProxy(
  value: string,
  options: SetCodexProxyOptions = {}
): Promise<SetCodexProxyResult> {
  const proxyUrl = normalizeCodexProxy(value);
  const codexHome = resolveCodexHome(options.codexHome);
  const configPath = path.join(codexHome, "config.toml");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });

  const release = await lockfile.lock(configPath, LOCK_OPTIONS);
  let environment: CodexProxyEnvironmentResult;
  try {
    const snapshot = await snapshotFile(configPath);
    const current = snapshot?.content.toString("utf8") ?? "";
    try {
      if (snapshot || proxyUrl !== null) {
        await atomicWriteFile(
          configPath,
          buildCodexProxyConfig(current, proxyUrl),
          snapshot?.mode ?? 0o600
        );
      }
      environment = await (options.applyProxyEnvironment
        ?? ((nextProxyUrl) => applyCodexProxyEnvironment(nextProxyUrl, options.platform)))(proxyUrl);
    } catch (error) {
      await restoreFile(configPath, snapshot).catch(() => undefined);
      throw error;
    }
  } finally {
    await release();
  }

  const restart = await (options.scheduleRestart ?? scheduleCodexAppRestart)();
  return { proxyUrl, configPath, environment, restart };
}

export function providerIdForName(name: string): string {
  const trimmed = name.trim();
  if (/^[A-Za-z0-9_-]+$/.test(trimmed) && !RESERVED_PROVIDER_IDS.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  const slug = trimmed
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "provider";
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  return `ai-${slug}-${digest}`;
}

export function listAvailableCodexGptModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(isCodexGptModel))]
    .sort(compareCodexGptModelsNewestFirst);
}

export function resolveCodexProviderModel(
  providerName: string,
  models: string[],
  requestedModel?: string
): string {
  const available = listAvailableCodexGptModels(models);
  if (!available.length) {
    throw new Error(
      `Provider ${providerName} has no available GPT models. Run \`ai status\` to refresh its model list.`
    );
  }
  if (!requestedModel) return available[0]!;

  const requested = assertCodexGptModel(requestedModel);
  const selected = available.find((model) => model.toLowerCase() === requested.toLowerCase());
  if (!selected) {
    throw new Error(
      `GPT model ${requested} is not available for provider ${providerName}. Available: ${available.join(", ")}`
    );
  }
  return selected;
}

export function buildCodexProviderConfig(
  current: string,
  provider: Provider,
  providerId: string,
  model: string = provider.model
): string {
  if (!provider.baseUrl.trim()) throw new Error(`Provider ${provider.name} has no base URL.`);
  if (!provider.apiKey.trim()) throw new Error(`Provider ${provider.name} has no API key.`);
  if (provider.requestProfile && provider.requestProfile.openaiAuth !== "bearer") {
    throw new Error(`Provider ${provider.name} requires ${provider.requestProfile.openaiAuth} for OpenAI requests; Codex persistent config currently supports Bearer authentication only.`);
  }
  const selectedModel = assertCodexGptModel(model);
  const baseUrl = getRunnerEngine("codex").normalizeBaseUrl(provider.baseUrl);
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  let next = removeProviderTables(current, providerId);
  next = setTopLevelTomlString(next, "cli_auth_credentials_store", "file");
  next = setTopLevelTomlString(next, "model_provider", providerId);
  next = setTopLevelTomlString(next, "model", selectedModel);

  const table = [
    `[model_providers.${providerId}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString("OPENAI_API_KEY")}`,
    `wire_api = ${tomlString("responses")}`
  ].join(eol);
  return `${next.trimEnd()}${eol}${eol}${table}${eol}`;
}

export function buildCodexChatGptConfig(current: string): string {
  let next = setTopLevelTomlString(current, "cli_auth_credentials_store", "file");
  next = setTopLevelTomlString(next, "model_provider", "openai");
  return ensureTrailingNewline(next);
}

export function normalizeCodexProxy(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Proxy address is required. Example: 127.0.0.1:7890");
  }
  if (["off", "none", "clear", "disable"].includes(trimmed.toLowerCase())) return null;

  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid proxy address: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Codex proxy must use http:// or https://.");
  }
  if (!parsed.hostname) throw new Error(`Invalid proxy address: ${value}`);
  if (parsed.username || parsed.password) {
    throw new Error("Proxy credentials are not accepted on the command line; use a local unauthenticated proxy endpoint.");
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("Codex proxy must be an origin only, without a path, query, or fragment.");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function buildCodexProxyConfig(current: string, proxyUrl: string | null): string {
  return updateTomlTableStrings(
    current,
    "shell_environment_policy.set",
    Object.fromEntries(CODEX_PROXY_ENV_KEYS.map((key) => [key, proxyUrl]))
  );
}

export async function applyCodexProxyEnvironment(
  proxyUrl: string | null,
  platform: NodeJS.Platform = process.platform
): Promise<CodexProxyEnvironmentResult> {
  if (platform !== "darwin") {
    return {
      applied: false,
      reason: "Automatic desktop proxy environment updates are currently supported on macOS only."
    };
  }

  const snapshots = new Map<string, string | null>();
  for (const key of CODEX_PROXY_ENV_KEYS) {
    const result = await runProcess("/bin/launchctl", ["getenv", key]);
    const previous = result.code === 0 ? result.stdout.replace(/\r?\n$/, "") : "";
    snapshots.set(key, previous || null);
  }

  const changed: string[] = [];
  try {
    for (const key of CODEX_PROXY_ENV_KEYS) {
      const args = proxyUrl === null ? ["unsetenv", key] : ["setenv", key, proxyUrl];
      const result = await runProcess("/bin/launchctl", args);
      if (result.code !== 0) {
        throw new Error(`launchctl ${args[0]} failed for ${key}: ${result.stderr.trim() || `exit ${result.code}`}`);
      }
      changed.push(key);
    }
  } catch (error) {
    for (const key of changed.reverse()) {
      const previous = snapshots.get(key);
      const args = previous === null || previous === undefined
        ? ["unsetenv", key]
        : ["setenv", key, previous];
      await runProcess("/bin/launchctl", args).catch(() => undefined);
    }
    throw error;
  }
  return { applied: true };
}

export async function scheduleCodexAppRestart(options: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appCandidates?: string[];
  pathExists?: (filePath: string) => Promise<boolean>;
  spawnDetached?: (command: string, args: string[], options?: SpawnDetachedOptions) => void;
} = {}): Promise<CodexAppRestartResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { scheduled: false, reason: "Automatic Codex app restart is currently supported on macOS only." };
  }

  const homeDir = options.homeDir ?? os.homedir();
  const candidates = options.appCandidates ?? [
    "/Applications/Codex.app",
    "/Applications/ChatGPT.app",
    path.join(homeDir, "Applications/Codex.app"),
    path.join(homeDir, "Applications/ChatGPT.app")
  ];
  const pathExists = options.pathExists ?? fileExists;
  let appPath: string | undefined;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      appPath = candidate;
      break;
    }
  }
  if (!appPath) {
    return { scheduled: false, reason: "Codex.app or ChatGPT.app was not found." };
  }

  const appName = path.basename(appPath, ".app");
  if (!/^[A-Za-z0-9 ._-]+$/.test(appName)) {
    return { scheduled: false, reason: `Unsupported application name: ${appName}` };
  }
  const appleScriptName = appName.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const helper = [
    "const { spawnSync } = require('node:child_process');",
    `const appPath = ${JSON.stringify(appPath)};`,
    `const quitScript = ${JSON.stringify(`tell application "${appleScriptName}" to quit`)};`,
    "setTimeout(() => {",
    "  spawnSync('/usr/bin/osascript', ['-e', quitScript], { stdio: 'ignore' });",
    "  setTimeout(() => spawnSync('/usr/bin/open', [appPath], { stdio: 'ignore' }), 1000);",
    "}, 750);"
  ].join("\n");
  const restartEnvironment = { ...process.env };
  delete restartEnvironment.OPENAI_API_KEY;
  (options.spawnDetached ?? defaultSpawnDetached)(process.execPath, ["-e", helper], {
    env: restartEnvironment
  });
  return { scheduled: true, appPath };
}

async function configureChatGpt(
  configPath: string,
  authPath: string,
  codexHome: string,
  runner: ChatGptLoginRunner | undefined
): Promise<void> {
  const [configSnapshot, authSnapshot] = await Promise.all([
    snapshotFile(configPath),
    snapshotFile(authPath)
  ]);
  try {
    const exitCode = await (runner ?? runCodexChatGptLogin)({ codexHome });
    if (exitCode !== 0) {
      throw new Error(`ChatGPT login failed with exit code ${exitCode}.`);
    }
    await validateChatGptAuth(authPath);
    await fs.chmod(authPath, 0o600);
    const currentConfig = configSnapshot?.content.toString("utf8") ?? "";
    await atomicWriteFile(configPath, buildCodexChatGptConfig(currentConfig), configSnapshot?.mode ?? 0o600);
  } catch (error) {
    await Promise.allSettled([
      restoreFile(configPath, configSnapshot),
      restoreFile(authPath, authSnapshot)
    ]);
    throw error;
  }
}

async function configureCustomProvider(
  configPath: string,
  authPath: string,
  provider: Provider,
  providerId: string,
  model: string
): Promise<void> {
  const [configSnapshot, authSnapshot] = await Promise.all([
    snapshotFile(configPath),
    snapshotFile(authPath)
  ]);
  const currentConfig = configSnapshot?.content.toString("utf8") ?? "";
  const auth = `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: provider.apiKey.trim() }, null, 2)}\n`;
  try {
    await atomicWriteFile(authPath, auth, 0o600);
    await atomicWriteFile(
      configPath,
      buildCodexProviderConfig(currentConfig, provider, providerId, model),
      configSnapshot?.mode ?? 0o600
    );
  } catch (error) {
    await Promise.allSettled([
      restoreFile(configPath, configSnapshot),
      restoreFile(authPath, authSnapshot)
    ]);
    throw error;
  }
}

async function runCodexChatGptLogin({ codexHome }: { codexHome: string }): Promise<number> {
  const command = resolveToolCommand("codex");
  if (!command) {
    throw new Error("Codex CLI not found. Run `ai setup --install-tools` first.");
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, ["-c", "cli_auth_credentials_store=\"file\"", "login"], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`ChatGPT login was interrupted by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function validateChatGptAuth(authPath: string): Promise<void> {
  let auth: unknown;
  try {
    auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch {
    throw new Error("ChatGPT login completed without a readable Codex auth.json.");
  }
  if (!isRecord(auth) || auth.auth_mode !== "chatgpt" || !isRecord(auth.tokens)) {
    throw new Error("ChatGPT login did not produce valid Codex credentials.");
  }
  if (typeof auth.tokens.access_token !== "string" || typeof auth.tokens.refresh_token !== "string") {
    throw new Error("ChatGPT login credentials are incomplete.");
  }
}

function setTopLevelTomlString(current: string, key: string, value: string): string {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[\[?/.test(line));
  const end = firstTable < 0 ? lines.length : firstTable;
  const assignment = `${key} = ${tomlString(value)}`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let replaced = false;
  const top = lines.slice(0, end).filter((line) => {
    if (!pattern.test(line)) return true;
    if (replaced) return false;
    replaced = true;
    return true;
  });
  if (replaced) {
    const index = top.findIndex((line) => pattern.test(line));
    top[index] = assignment;
  } else {
    while (top.length && top[top.length - 1] === "") top.pop();
    top.push(assignment, "");
  }
  return [...top, ...lines.slice(end)].join(eol);
}

function updateTomlTableStrings(
  current: string,
  tableName: string,
  values: Record<string, string | null>
): string {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const tablePattern = new RegExp(`^\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?$`);
  const tableIndex = lines.findIndex((line) => tablePattern.test(line));
  const assignments = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key} = ${tomlString(value)}`);

  if (tableIndex < 0) {
    if (!assignments.length) return ensureTrailingNewline(current);
    const prefix = current.trimEnd();
    const table = [`[${tableName}]`, ...assignments].join(eol);
    return `${prefix ? `${prefix}${eol}${eol}` : ""}${table}${eol}`;
  }

  let tableEnd = lines.length;
  for (let index = tableIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?/.test(lines[index]!)) {
      tableEnd = index;
      break;
    }
  }
  const managedPatterns = Object.keys(values).map(
    (key) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  );
  const body = lines
    .slice(tableIndex + 1, tableEnd)
    .filter((line) => !managedPatterns.some((pattern) => pattern.test(line)));
  while (body.length && body[body.length - 1] === "") body.pop();
  if (body.length && assignments.length) body.push("");
  body.push(...assignments);

  return ensureTrailingNewline([
    ...lines.slice(0, tableIndex + 1),
    ...body,
    ...lines.slice(tableEnd)
  ].join(eol));
}

function removeProviderTables(current: string, providerId: string): string {
  const lines = current.split(/\r?\n/);
  const prefix = `model_providers.${providerId}`;
  let skip = false;
  const kept: string[] = [];
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header) {
      skip = header === prefix || header.startsWith(`${prefix}.`);
    }
    if (!skip) kept.push(line);
  }
  return kept.join(current.includes("\r\n") ? "\r\n" : "\n");
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return { content, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function restoreFile(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await atomicWriteFile(filePath, snapshot.content, snapshot.mode);
}

async function atomicWriteFile(filePath: string, content: string | Buffer, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(temporaryPath, content, { mode });
    await fs.chmod(temporaryPath, mode);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function resolveCodexHome(explicit?: string): string {
  const value = explicit ?? process.env.CODEX_HOME;
  return value ? path.resolve(value) : path.join(os.homedir(), ".codex");
}

function ensureTrailingNewline(value: string): string {
  return `${value.trimEnd()}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCodexGptModel(model: string): string {
  const value = model.trim();
  if (!isCodexGptModel(value)) {
    throw new Error(`Codex provider model must be a GPT model id starting with \"gpt-\": ${model || "(empty)"}`);
  }
  return value;
}

function isCodexGptModel(model: string): boolean {
  return /^gpt-/i.test(model.trim());
}

function compareCodexGptModelsNewestFirst(left: string, right: string): number {
  const leftKey = codexGptModelSortKey(left);
  const rightKey = codexGptModelSortKey(right);
  const versionLength = Math.max(leftKey.version.length, rightKey.version.length);
  for (let index = 0; index < versionLength; index += 1) {
    const difference = (rightKey.version[index] ?? -1) - (leftKey.version[index] ?? -1);
    if (difference) return difference;
  }
  if (leftKey.tier !== rightKey.tier) return rightKey.tier - leftKey.tier;
  if (leftKey.alias !== rightKey.alias) return rightKey.alias - leftKey.alias;
  if (leftKey.snapshot !== rightKey.snapshot) return rightKey.snapshot - leftKey.snapshot;
  return left.localeCompare(right);
}

function codexGptModelSortKey(model: string): {
  version: number[];
  tier: number;
  alias: number;
  snapshot: number;
} {
  const value = model.toLowerCase();
  const version = /^gpt-(\d+(?:\.\d+)*)/.exec(value)?.[1]
    ?.split(".")
    .map(Number) ?? [];
  const snapshotMatch = /(?:^|-)(\d{4})-(\d{2})-(\d{2})(?:$|-)/.exec(value);
  const snapshot = snapshotMatch
    ? Number(`${snapshotMatch[1]}${snapshotMatch[2]}${snapshotMatch[3]}`)
    : 0;
  const tier = /(?:^|-)sol(?:-|$)/.test(value) ? 60
    : /(?:^|-)pro(?:-|$)/.test(value) ? 50
      : /^gpt-\d+(?:\.\d+)*(?:-\d{4}-\d{2}-\d{2})?$/.test(value) ? 45
        : /(?:^|-)codex(?:-|$)/.test(value) ? 40
          : /(?:^|-)terra(?:-|$)/.test(value) ? 30
            : /(?:^|-)mini(?:-|$)/.test(value) ? 20
              : /(?:^|-)luna(?:-|$)/.test(value) ? 10
                : /(?:^|-)nano(?:-|$)/.test(value) ? 5
                  : 0;
  return { version, tier, alias: snapshot ? 0 : 1, snapshot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultSpawnDetached(command: string, args: string[], options: SpawnDetachedOptions = {}): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
  child.unref();
}

function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was interrupted by ${signal}.`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
