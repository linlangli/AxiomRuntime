import { writeLog } from "../logs/log-service.js";
import path from "node:path";
import { buildFixPrompt, buildInitialReviewPrompt, buildJudgePrompt } from "./review-prompts.js";
import { createReviewHandoff, mergeReviewFindings, parseInitialReview, parseJudgeReview } from "./review-parser.js";
import type {
  ReviewAgentPort,
  ReviewConfig,
  ReviewEngineName,
  ReviewGitPort,
  ReviewRound,
  ReviewSource,
  ReviewWorkflowCallbacks,
  ReviewWorkflowInput,
  ReviewWorkflowResult
} from "./types.js";

export class ReviewService {
  constructor(
    private readonly agent: ReviewAgentPort,
    private readonly git: ReviewGitPort
  ) {}

  async run(input: ReviewWorkflowInput, callbacks: ReviewWorkflowCallbacks): Promise<ReviewWorkflowResult> {
    const root = await this.git.getRepositoryRoot(input.cwd);
    await this.git.assertClean(root);
    let targetCommit = await this.git.resolveCommit(root, input.target ?? inferReviewTarget(input.request));
    let reviewerEngine = input.config.firstEngine;
    let judgeEngine = otherEngine(reviewerEngine);
    const rounds: ReviewRound[] = [];
    const commits: string[] = [];

    for (let roundNumber = 1; ; roundNumber += 1) {
      const reviewer = sourceFor(input.config, reviewerEngine);
      const judge = sourceFor(input.config, judgeEngine);
      const commitText = await this.git.readCommit(root, targetCommit);
      await callbacks.onStage?.(`第 ${roundNumber} 轮：${formatDisplaySource(reviewer)} 正在审阅提交 ${targetCommit.slice(0, 12)}。`);
      const initialResult = await this.agent.execute({
        ...reviewer,
        cwd: root,
        mode: "readOnly",
        prompt: buildInitialReviewPrompt({ request: input.request, commit: targetCommit, commitText })
      });
      const initial = parseInitialReview(initialResult.response);

      if (!initial.findings.length) {
        const cleanRound: ReviewRound = {
          round: roundNumber,
          targetCommit,
          reviewer,
          judge,
          reviewerSummary: initial.summary,
          judgeSummary: "首审未发现问题，未调用第二模型。",
          judgeExecuted: false,
          findings: [],
          omittedFindingCount: 0
        };
        rounds.push(cleanRound);
        await callbacks.onRound?.(cleanRound);
        await writeReviewRoundLog(cleanRound);
        await callbacks.onStage?.("首审未发现需要处理的问题，已跳过第二模型调用。");
        return { status: "clean", rounds, commits };
      }

      const handoff = createReviewHandoff({ round: roundNumber, targetCommit, reviewer, initial });

      await callbacks.onStage?.(`第 ${roundNumber} 轮：${formatDisplaySource(judge)} 正在验证 ${formatDisplaySource(reviewer)} 的 ${handoff.findings.length} 条首审结论。`);
      const judgeResult = await this.agent.execute({
        ...judge,
        cwd: root,
        mode: "readOnly",
        scopeFiles: collectHandoffScopeFiles(root, handoff.findings),
        prompt: buildJudgePrompt({ handoff })
      });
      const adjudication = parseJudgeReview(judgeResult.response);
      const reviewRound: ReviewRound = {
        round: roundNumber,
        targetCommit,
        reviewer,
        judge,
        reviewerSummary: initial.summary,
        judgeSummary: adjudication.summary,
        judgeExecuted: true,
        omittedFindingCount: handoff.omittedFindingCount,
        findings: mergeReviewFindings({
          round: roundNumber,
          reviewer: initialResult,
          judge: judgeResult,
          initial,
          adjudication
        })
      };
      rounds.push(reviewRound);
      await callbacks.onRound?.(reviewRound);
      await writeReviewRoundLog(reviewRound);

      const selection = await callbacks.selectFindings(reviewRound);
      if (selection.action === "abandon") {
        await callbacks.onStage?.("审阅已由用户停止，未做其他修改。");
        return { status: "abandoned", rounds, commits };
      }
      const selected = reviewRound.findings.filter((finding) => selection.findingIds.includes(finding.id));
      if (!selected.length) {
        throw new Error("没有选择有效的审阅问题。");
      }

      await this.git.assertClean(root);
      const headBeforeFix = await this.git.resolveCommit(root, "HEAD");
      for (const finding of selected) {
        await callbacks.onStage?.(`第 ${roundNumber} 轮：${formatDisplaySource(reviewer)} 正在处理问题 ${finding.id}。`);
        await this.agent.execute({
          ...reviewer,
          cwd: root,
          mode: "workspaceWrite",
          scopeFiles: collectFixScopeFiles(root, [finding]),
          prompt: buildFixPrompt({ request: input.request, commit: targetCommit, selected: [finding] })
        });
        const headAfterFinding = await this.git.resolveCommit(root, "HEAD");
        if (headAfterFinding !== headBeforeFix) {
          throw new Error("修复模型意外创建了 Git 提交，请人工检查仓库后再继续。");
        }
      }
      const status = await this.git.readStatus(root);
      if (!status.trim()) {
        await callbacks.onStage?.("修复模型没有修改文件，审阅循环已停止且未创建提交。");
        return { status: "no_changes", rounds, commits };
      }

      const commit = await this.git.commitAll(
        root,
        `fix(review): address round ${roundNumber} findings`,
        buildCommitBody(reviewRound, selected.map((finding) => finding.id))
      );
      commits.push(commit);
      await callbacks.onStage?.(`已创建提交 ${commit.slice(0, 12)}。下一轮将由另一个模型审阅该提交。`);
      targetCommit = commit;
      [reviewerEngine, judgeEngine] = [judgeEngine, reviewerEngine];
    }
  }
}

function collectFixScopeFiles(root: string, findings: ReviewRound["findings"]): string[] {
  return collectScopeFiles(root, findings);
}

function collectHandoffScopeFiles(root: string, findings: Array<{ file: string | null }>): string[] {
  return collectScopeFiles(root, findings);
}

function collectScopeFiles(root: string, findings: Array<{ file: string | null }>): string[] {
  const files = new Set<string>();
  for (const finding of findings) {
    if (!finding.file) continue;
    const candidate = finding.file.trim().replaceAll("\\", "/");
    if (!candidate || candidate.includes("\0") || path.isAbsolute(candidate) || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) continue;
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    files.add(relative.split(path.sep).join("/"));
  }
  return [...files];
}

export function inferReviewTarget(request: string): string {
  const patterns = [
    /\bcommit\s*id\s*(?:is|=|:|为|是)?\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,127})/i,
    /\bcommit\s+(?:is|=|:|为|是)?\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,127})/i,
    /提交\s*(?:id)?\s*(?:为|是|=|:)?\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,127})/i,
    /\b([0-9a-f]{7,40})\b/i
  ];
  for (const pattern of patterns) {
    const target = pattern.exec(request)?.[1];
    if (target) return target;
  }
  return "HEAD";
}

function sourceFor(config: ReviewConfig, engine: ReviewEngineName): ReviewSource {
  return { engine, provider: config[engine].provider, model: config[engine].model };
}

function otherEngine(engine: ReviewEngineName): ReviewEngineName {
  return engine === "codex" ? "claude" : "codex";
}

function formatSource(source: ReviewSource): string {
  return `${source.engine} ${source.provider}/${source.model}`;
}

function formatDisplaySource(source: ReviewSource): string {
  return `${source.engine === "claude" ? "Claude Code" : "Codex"} ${source.provider}/${source.model}`;
}

function buildCommitBody(round: ReviewRound, findingIds: string[]): string {
  return [
    `Review-Round: ${round.round}`,
    `Review-Findings: ${findingIds.join(",")}`,
    `Review-Fixer: ${formatSource(round.reviewer)}`,
    `Review-Judge: ${formatSource(round.judge)}`
  ].join("\n");
}

async function writeReviewRoundLog(round: ReviewRound): Promise<void> {
  await writeLog({
    category: "strategy",
    action: "review_round_completed",
    message: `Review round ${round.round} completed with ${round.findings.length} finding(s).`,
    metadata: {
      round: round.round,
      targetCommit: round.targetCommit,
      reviewer: round.reviewer,
      judge: round.judge,
      findingCount: round.findings.length,
      consensusCount: round.findings.filter((finding) => finding.consensus).length,
      judgeExecuted: round.judgeExecuted,
      omittedFindingCount: round.omittedFindingCount
    }
  });
}
