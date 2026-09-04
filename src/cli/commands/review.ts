import { readCache } from "../../core/config/cache-store.js";
import { readProviders } from "../../core/config/providers-store.js";
import { isModelCompatible } from "../../core/models/model-filter.js";
import { CliReviewAgent } from "../../core/review/review-agent.js";
import { clearReviewConfig, readReviewConfig, writeReviewConfig } from "../../core/review/review-config.js";
import { LocalReviewGit } from "../../core/review/review-git.js";
import { ReviewService } from "../../core/review/review-service.js";
import type {
  ReviewConfig,
  ReviewEngineConfig,
  ReviewEngineName,
  ReviewFinding,
  ReviewRound,
  ReviewSelection
} from "../../core/review/types.js";
import type { CacheFile, Provider } from "../../core/types.js";
import type { PromptSelectOptions } from "../prompts/prompt.js";
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

type SelectPrompt = <T extends string | number>(
  message: string,
  choices: Array<{ label: string; value: T }>,
  options?: PromptSelectOptions
) => Promise<T>;

const reviewSelectOptions: PromptSelectOptions = {
  inputLabel: "请输入选项编号",
  invalidInputMessage: (choiceCount) => `请输入 1 到 ${choiceCount} 之间的数字。`
};

export async function runReviewCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  if (subcommand === "config") {
    if (args[1] === "show") {
      printReviewConfig(await readReviewConfig());
      return;
    }
    const config = await configureReviewModels();
    printReviewConfig(config);
    return;
  }
  if (subcommand === "reset") {
    if (await promptConfirm("清除已保存的审阅模型配置吗？")) {
      await clearReviewConfig();
      console.log("审阅模型配置已清除。");
    }
    return;
  }

  let config = await readReviewConfig();
  if (!config) {
    console.log("尚未配置审阅模型。");
    config = await configureReviewModels();
  }
  const parsed = parseReviewCommandArgs(args);
  const request = parsed.request || await promptText("审阅要求", { defaultValue: "审阅 HEAD 提交" });
  if (!request) throw new Error("审阅要求不能为空。");

  const service = new ReviewService(new CliReviewAgent(), new LocalReviewGit());
  const result = await service.run({ cwd: process.cwd(), request, target: parsed.target, config }, {
    onStage: (message) => console.log(`\n${message}`),
    onRound: printReviewRound,
    selectFindings
  });

  console.log(`\n审阅结束：${formatReviewStatus(result.status)}。`);
  if (result.commits.length) {
    console.log(`已创建提交：${result.commits.map((commit) => commit.slice(0, 12)).join(", ")}`);
  }
}

export async function configureReviewModels(select: SelectPrompt = promptSelect): Promise<ReviewConfig> {
  const providers = await readProviders();
  const cache = await readCache();
  const missingEngines = (["codex", "claude"] as const)
    .filter((engine) => getReviewModelOptions(engine, providers, cache).length === 0);
  if (missingEngines.length) {
    throw new Error(`没有可用于 ${missingEngines.map(engineLabel).join("、")} 的缓存模型。请先运行 \`ai status\`。`);
  }
  const firstEngine = await select<ReviewEngineName>("选择首审引擎", [
    { label: "Codex", value: "codex" },
    { label: "Claude Code", value: "claude" }
  ], reviewSelectOptions);
  const firstConfig = await selectReviewEngineConfig(firstEngine, providers, cache, select);
  const secondEngine = firstEngine === "codex" ? "claude" : "codex";
  const secondConfig = await selectReviewEngineConfig(secondEngine, providers, cache, select);
  const codex = firstEngine === "codex" ? firstConfig : secondConfig;
  const claude = firstEngine === "claude" ? firstConfig : secondConfig;
  return writeReviewConfig({ version: 1, firstEngine, codex, claude });
}

export function parseReviewCommandArgs(args: string[]): { target?: string; request: string } {
  const requestParts: string[] = [];
  let target: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--commit") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--commit 后必须提供 Git commit 或 ref。");
      target = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--commit=")) {
      target = arg.slice("--commit=".length).trim();
      if (!target) throw new Error("--commit 后必须提供 Git commit 或 ref。");
      continue;
    }
    requestParts.push(arg);
  }
  return { target, request: requestParts.join(" ").trim() };
}

export function getReviewModelOptions(
  engine: ReviewEngineName,
  providers: Provider[],
  cache: CacheFile
): Array<{ provider: Provider; models: string[] }> {
  return providers.flatMap((provider) => {
    const models = (cache.providers[provider.name]?.models ?? []).filter((model) => isModelCompatible(engine, model));
    return models.length ? [{ provider, models }] : [];
  });
}

async function selectReviewEngineConfig(
  engine: ReviewEngineName,
  providers: Provider[],
  cache: CacheFile,
  select: SelectPrompt
): Promise<ReviewEngineConfig> {
  const options = getReviewModelOptions(engine, providers, cache);
  if (!options.length) {
    throw new Error(`没有已配置的 Provider 缓存 ${engineLabel(engine)} 模型。请先运行 \`ai status\`。`);
  }
  const providerName = await select(`选择 ${engineLabel(engine)} 的 Provider`, options.map(({ provider, models }) => ({
    label: `${provider.name}（${models.length} 个模型）`,
    value: provider.name
  })), reviewSelectOptions);
  const selected = options.find(({ provider }) => provider.name === providerName)!;
  const model = await select(`选择 ${engineLabel(engine)} / ${providerName} 的模型`, selected.models.map((candidate) => ({
    label: candidate,
    value: candidate
  })), reviewSelectOptions);
  return { provider: providerName, model };
}

async function selectFindings(round: ReviewRound): Promise<ReviewSelection> {
  const choices: Array<{ label: string; value: string }> = [];
  const consensus = round.findings.filter((finding) => finding.consensus);
  if (consensus.length) {
    choices.push({ label: `修复双方共识的 ${consensus.length} 个问题`, value: "consensus" });
  }
  choices.push(
    { label: `修复全部 ${round.findings.length} 个问题`, value: "all" },
    { label: "选择问题编号", value: "choose" },
    { label: "放弃并停止审阅", value: "abandon" }
  );
  const action = await promptSelect("选择要修复的内容", choices, reviewSelectOptions);
  if (action === "abandon") return { action: "abandon" };
  if (action === "consensus") return { action: "fix", findingIds: consensus.map((finding) => finding.id) };
  if (action === "all") return { action: "fix", findingIds: round.findings.map((finding) => finding.id) };

  while (true) {
    const raw = await promptText("请输入问题编号（用逗号或空格分隔）");
    const ids = [...new Set(raw.split(/[\s,]+/).map((value) => value.trim().toUpperCase()).filter(Boolean))];
    const valid = ids.filter((id) => round.findings.some((finding) => finding.id.toUpperCase() === id));
    if (valid.length === ids.length && valid.length) return { action: "fix", findingIds: valid };
    console.log(`可用的问题编号：${round.findings.map((finding) => finding.id).join(", ")}`);
  }
}

function printReviewRound(round: ReviewRound): void {
  console.log(`\n第 ${round.round} 轮审阅 — 提交 ${round.targetCommit.slice(0, 12)}`);
  console.log(`首审模型：${formatSource(round.reviewer)}`);
  console.log(`第二模型裁决：${formatSource(round.judge)}（已收到首审完整报告）`);
  console.log(`首审总结：${round.reviewerSummary}`);
  console.log(`裁决总结：${round.judgeSummary}`);
  if (!round.findings.length) {
    console.log("没有需要处理的问题。");
    return;
  }
  const firstReviewFindings = round.findings.filter((finding) => finding.sources.some((source) => sameSource(source, round.reviewer)));
  const judgeAddedFindings = round.findings.filter((finding) => !finding.sources.some((source) => sameSource(source, round.reviewer)));
  if (firstReviewFindings.length) {
    console.log(`\n首审问题（${firstReviewFindings.length} 个），已由 ${formatSource(round.judge)} 裁决：`);
    for (const finding of firstReviewFindings) printFinding(finding);
  }
  if (judgeAddedFindings.length) {
    console.log(`\n${formatSource(round.judge)} 新增的问题（尚未交叉验证）：`);
    for (const finding of judgeAddedFindings) printFinding(finding);
  }
}

function printFinding(finding: ReviewFinding): void {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "（无位置）";
  const sources = finding.sources.map(formatSource).join(" + ");
  console.log(`\n${finding.id} [${formatSeverity(finding.severity)}] [${formatVerdict(finding)}] ${finding.title}`);
  console.log(`  来源：${sources}`);
  console.log(`  位置：${location}`);
  console.log(`  证据：${finding.evidence}`);
  console.log(`  建议修复：${finding.recommendation}`);
  console.log(`  第二模型意见：${finding.verdictReason}`);
}

function printReviewConfig(config: ReviewConfig | null): void {
  if (!config) {
    console.log("尚未配置审阅模型。");
    return;
  }
  console.log(`首审引擎：${engineLabel(config.firstEngine)}`);
  console.log(`Codex 配置：${config.codex.provider} / ${config.codex.model}`);
  console.log(`Claude Code 配置：${config.claude.provider} / ${config.claude.model}`);
}

function formatSource(source: { engine: ReviewEngineName; provider: string; model: string }): string {
  return `${engineLabel(source.engine)} ${source.provider}/${source.model}`;
}

function engineLabel(engine: ReviewEngineName): string {
  return engine === "claude" ? "Claude Code" : "Codex";
}

function formatSeverity(severity: ReviewFinding["severity"]): string {
  const labels = { critical: "严重", high: "高", medium: "中", low: "低" } as const;
  return `${labels[severity]} / ${severity.toUpperCase()}`;
}

function formatVerdict(finding: ReviewFinding): string {
  if (finding.consensus) return "双方共识 / CONSENSUS";
  const labels = { agree: "同意", disagree: "反对", uncertain: "不确定", unverified: "未交叉验证" } as const;
  return `${labels[finding.verdict]} / ${finding.verdict.toUpperCase()}`;
}

function formatReviewStatus(status: "clean" | "abandoned" | "no_changes"): string {
  const labels = { clean: "通过", abandoned: "已放弃", no_changes: "未产生修改" } as const;
  return labels[status];
}

function sameSource(
  left: { engine: ReviewEngineName; provider: string; model: string },
  right: { engine: ReviewEngineName; provider: string; model: string }
): boolean {
  return left.engine === right.engine && left.provider === right.provider && left.model === right.model;
}
