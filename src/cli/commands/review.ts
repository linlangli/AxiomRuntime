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
import { promptConfirm, promptSelect, promptText } from "../prompts/prompt.js";

type SelectPrompt = <T extends string | number>(message: string, choices: Array<{ label: string; value: T }>) => Promise<T>;

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
    if (await promptConfirm("Clear saved review model configuration?")) {
      await clearReviewConfig();
      console.log("Review model configuration cleared.");
    }
    return;
  }

  let config = await readReviewConfig();
  if (!config) {
    console.log("Review models are not configured yet.");
    config = await configureReviewModels();
  }
  const parsed = parseReviewCommandArgs(args);
  const request = parsed.request || await promptText("Review request", { defaultValue: "Review the HEAD commit" });
  if (!request) throw new Error("Review request cannot be empty.");

  const service = new ReviewService(new CliReviewAgent(), new LocalReviewGit());
  const result = await service.run({ cwd: process.cwd(), request, target: parsed.target, config }, {
    onStage: (message) => console.log(`\n${message}`),
    onRound: printReviewRound,
    selectFindings
  });

  console.log(`\nReview finished: ${result.status}.`);
  if (result.commits.length) {
    console.log(`Created commits: ${result.commits.map((commit) => commit.slice(0, 12)).join(", ")}`);
  }
}

export async function configureReviewModels(select: SelectPrompt = promptSelect): Promise<ReviewConfig> {
  const providers = await readProviders();
  const cache = await readCache();
  const missingEngines = (["codex", "claude"] as const)
    .filter((engine) => getReviewModelOptions(engine, providers, cache).length === 0);
  if (missingEngines.length) {
    throw new Error(`No cached model selection is available for ${missingEngines.join(" and ")}. Run \`ai status\` first.`);
  }
  const firstEngine = await select<ReviewEngineName>("Select the first review engine", [
    { label: "Codex", value: "codex" },
    { label: "Claude Code", value: "claude" }
  ]);
  const codex = await selectReviewEngineConfig("codex", providers, cache, select);
  const claude = await selectReviewEngineConfig("claude", providers, cache, select);
  return writeReviewConfig({ version: 1, firstEngine, codex, claude });
}

export function parseReviewCommandArgs(args: string[]): { target?: string; request: string } {
  const requestParts: string[] = [];
  let target: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--commit") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--commit requires a Git commit or ref.");
      target = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--commit=")) {
      target = arg.slice("--commit=".length).trim();
      if (!target) throw new Error("--commit requires a Git commit or ref.");
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
    throw new Error(`No configured provider has cached ${engine} models. Run \`ai status\` first.`);
  }
  const providerName = await select(`Select provider for ${engine}`, options.map(({ provider, models }) => ({
    label: `${provider.name} (${models.length} model${models.length === 1 ? "" : "s"})`,
    value: provider.name
  })));
  const selected = options.find(({ provider }) => provider.name === providerName)!;
  const model = await select(`Select model for ${engine} / ${providerName}`, selected.models.map((candidate) => ({
    label: candidate,
    value: candidate
  })));
  return { provider: providerName, model };
}

async function selectFindings(round: ReviewRound): Promise<ReviewSelection> {
  const choices: Array<{ label: string; value: string }> = [];
  const consensus = round.findings.filter((finding) => finding.consensus);
  if (consensus.length) {
    choices.push({ label: `Fix ${consensus.length} consensus finding(s)`, value: "consensus" });
  }
  choices.push(
    { label: `Fix all ${round.findings.length} finding(s)`, value: "all" },
    { label: "Choose finding IDs", value: "choose" },
    { label: "Abandon and stop review", value: "abandon" }
  );
  const action = await promptSelect("Choose what to fix", choices);
  if (action === "abandon") return { action: "abandon" };
  if (action === "consensus") return { action: "fix", findingIds: consensus.map((finding) => finding.id) };
  if (action === "all") return { action: "fix", findingIds: round.findings.map((finding) => finding.id) };

  while (true) {
    const raw = await promptText("Finding IDs (comma or space separated)");
    const ids = [...new Set(raw.split(/[\s,]+/).map((value) => value.trim().toUpperCase()).filter(Boolean))];
    const valid = ids.filter((id) => round.findings.some((finding) => finding.id.toUpperCase() === id));
    if (valid.length === ids.length && valid.length) return { action: "fix", findingIds: valid };
    console.log(`Valid IDs: ${round.findings.map((finding) => finding.id).join(", ")}`);
  }
}

function printReviewRound(round: ReviewRound): void {
  console.log(`\nReview round ${round.round} — ${round.targetCommit.slice(0, 12)}`);
  console.log(`First review: ${formatSource(round.reviewer)}`);
  console.log(`Adjudication: ${formatSource(round.judge)}`);
  console.log(`Reviewer summary: ${round.reviewerSummary}`);
  console.log(`Judge summary: ${round.judgeSummary}`);
  if (!round.findings.length) {
    console.log("No actionable findings.");
    return;
  }
  for (const finding of round.findings) printFinding(finding);
}

function printFinding(finding: ReviewFinding): void {
  const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(no location)";
  const sources = finding.sources.map(formatSource).join(" + ");
  const status = finding.consensus ? "CONSENSUS" : finding.verdict.toUpperCase();
  console.log(`\n${finding.id} [${finding.severity.toUpperCase()}] [${status}] ${finding.title}`);
  console.log(`  Source: ${sources}`);
  console.log(`  Location: ${location}`);
  console.log(`  Evidence: ${finding.evidence}`);
  console.log(`  Suggested fix: ${finding.recommendation}`);
  console.log(`  Second opinion: ${finding.verdictReason}`);
}

function printReviewConfig(config: ReviewConfig | null): void {
  if (!config) {
    console.log("Review models are not configured.");
    return;
  }
  console.log(`First engine: ${config.firstEngine}`);
  console.log(`Codex: ${config.codex.provider} / ${config.codex.model}`);
  console.log(`Claude Code: ${config.claude.provider} / ${config.claude.model}`);
}

function formatSource(source: { engine: ReviewEngineName; provider: string; model: string }): string {
  return `${source.engine} ${source.provider}/${source.model}`;
}
