import type { CliToolType } from "../types.js";

export type ReviewEngineName = CliToolType;

export type ReviewEngineConfig = {
  provider: string;
  model: string;
};

export type ReviewConfig = {
  version: 1;
  firstEngine: ReviewEngineName;
  claude: ReviewEngineConfig;
  codex: ReviewEngineConfig;
};

export type ReviewSeverity = "critical" | "high" | "medium" | "low";
export type ReviewVerdict = "agree" | "disagree" | "uncertain" | "unverified";

export type ReviewSource = {
  engine: ReviewEngineName;
  provider: string;
  model: string;
};

export type ReviewHandoffFinding = {
  id: string;
  severity: ReviewSeverity;
  title: string;
  file: string | null;
  line: number | null;
  claim: string;
};

export type ReviewHandoff = {
  version: 1;
  round: number;
  targetCommit: string;
  reviewer: ReviewSource;
  summary: string;
  findings: ReviewHandoffFinding[];
  omittedFindingCount: number;
};

export type ReviewFinding = {
  id: string;
  severity: ReviewSeverity;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
  recommendation: string;
  sources: ReviewSource[];
  verdict: ReviewVerdict;
  verdictReason: string;
  consensus: boolean;
};

export type ReviewRound = {
  round: number;
  targetCommit: string;
  reviewer: ReviewSource;
  judge: ReviewSource;
  reviewerSummary: string;
  judgeSummary: string;
  judgeExecuted: boolean;
  findings: ReviewFinding[];
  omittedFindingCount: number;
};

export type ReviewSelection =
  | { action: "abandon" }
  | { action: "fix"; findingIds: string[] };

export type ReviewWorkflowInput = {
  cwd: string;
  request: string;
  target?: string;
  config: ReviewConfig;
};

export type ReviewWorkflowResult = {
  status: "clean" | "abandoned" | "no_changes";
  rounds: ReviewRound[];
  commits: string[];
};

export type ReviewAgentMode = "readOnly" | "workspaceWrite";

export type ReviewAgentRequest = ReviewSource & {
  cwd: string;
  prompt: string;
  mode: ReviewAgentMode;
  scopeFiles?: string[];
};

export type ReviewAgentResult = ReviewSource & {
  response: string;
};

export interface ReviewAgentPort {
  execute(request: ReviewAgentRequest): Promise<ReviewAgentResult>;
}

export interface ReviewGitPort {
  getRepositoryRoot(cwd: string): Promise<string>;
  assertClean(cwd: string): Promise<void>;
  resolveCommit(cwd: string, target: string): Promise<string>;
  readCommit(cwd: string, commit: string): Promise<string>;
  readStatus(cwd: string): Promise<string>;
  commitAll(cwd: string, subject: string, body: string): Promise<string>;
}

export type ReviewWorkflowCallbacks = {
  onStage?(message: string): void | Promise<void>;
  onRound?(round: ReviewRound): void | Promise<void>;
  selectFindings(round: ReviewRound): Promise<ReviewSelection>;
};
