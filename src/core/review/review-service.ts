import { writeLog } from "../logs/log-service.js";
import { buildFixPrompt, buildInitialReviewPrompt, buildJudgePrompt } from "./review-prompts.js";
import { mergeReviewFindings, parseInitialReview, parseJudgeReview } from "./review-parser.js";
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
      await callbacks.onStage?.(`Round ${roundNumber}: ${formatSource(reviewer)} is reviewing ${targetCommit.slice(0, 12)}.`);
      const initialResult = await this.agent.execute({
        ...reviewer,
        cwd: root,
        mode: "readOnly",
        prompt: buildInitialReviewPrompt({ request: input.request, commit: targetCommit, commitText })
      });
      const initial = parseInitialReview(initialResult.response);

      await callbacks.onStage?.(`Round ${roundNumber}: ${formatSource(judge)} is validating the first review.`);
      const judgeResult = await this.agent.execute({
        ...judge,
        cwd: root,
        mode: "readOnly",
        prompt: buildJudgePrompt({ request: input.request, commit: targetCommit, commitText, reviewer, initial })
      });
      const adjudication = parseJudgeReview(judgeResult.response);
      const reviewRound: ReviewRound = {
        round: roundNumber,
        targetCommit,
        reviewer,
        judge,
        reviewerSummary: initial.summary,
        judgeSummary: adjudication.summary,
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

      if (!reviewRound.findings.length) {
        await callbacks.onStage?.("Both review passes completed without actionable findings.");
        return { status: "clean", rounds, commits };
      }

      const selection = await callbacks.selectFindings(reviewRound);
      if (selection.action === "abandon") {
        await callbacks.onStage?.("Review stopped by user. No additional changes were made.");
        return { status: "abandoned", rounds, commits };
      }
      const selected = reviewRound.findings.filter((finding) => selection.findingIds.includes(finding.id));
      if (!selected.length) {
        throw new Error("No valid review findings were selected.");
      }

      await this.git.assertClean(root);
      const headBeforeFix = await this.git.resolveCommit(root, "HEAD");
      await callbacks.onStage?.(`Round ${roundNumber}: ${formatSource(reviewer)} is applying ${selected.length} selected finding(s).`);
      await this.agent.execute({
        ...reviewer,
        cwd: root,
        mode: "workspaceWrite",
        prompt: buildFixPrompt({ request: input.request, commit: targetCommit, selected })
      });
      const headAfterFix = await this.git.resolveCommit(root, "HEAD");
      if (headAfterFix !== headBeforeFix) {
        throw new Error("The fixing model created a Git commit unexpectedly. Review the repository manually before continuing.");
      }
      const status = await this.git.readStatus(root);
      if (!status.trim()) {
        await callbacks.onStage?.("The fixing model made no file changes; the review loop stopped without a commit.");
        return { status: "no_changes", rounds, commits };
      }

      const commit = await this.git.commitAll(
        root,
        `fix(review): address round ${roundNumber} findings`,
        buildCommitBody(reviewRound, selected.map((finding) => finding.id))
      );
      commits.push(commit);
      await callbacks.onStage?.(`Created ${commit.slice(0, 12)}. The other model will review this commit next.`);
      targetCommit = commit;
      [reviewerEngine, judgeEngine] = [judgeEngine, reviewerEngine];
    }
  }
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
      consensusCount: round.findings.filter((finding) => finding.consensus).length
    }
  });
}
