import type {
  ReviewAgentResult,
  ReviewFinding,
  ReviewSeverity,
  ReviewSource,
  ReviewVerdict
} from "./types.js";

export type ParsedReviewFinding = {
  severity: ReviewSeverity;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
  recommendation: string;
};

export type ParsedInitialReview = {
  summary: string;
  findings: ParsedReviewFinding[];
};

export type ParsedAssessment = {
  index: number;
  verdict: Exclude<ReviewVerdict, "unverified">;
  reason: string;
};

export type ParsedJudgeReview = ParsedInitialReview & {
  assessments: ParsedAssessment[];
};

export function parseInitialReview(response: string): ParsedInitialReview {
  const payload = readJsonObject(response);
  return {
    summary: readText(payload.summary, "No summary provided."),
    findings: readFindings(payload.findings)
  };
}

export function parseJudgeReview(response: string): ParsedJudgeReview {
  const payload = readJsonObject(response);
  const assessments = Array.isArray(payload.assessments)
    ? payload.assessments.flatMap((value) => normalizeAssessment(value))
    : [];
  return {
    summary: readText(payload.summary, "No summary provided."),
    findings: readFindings(payload.findings),
    assessments
  };
}

export function mergeReviewFindings(input: {
  round: number;
  reviewer: ReviewAgentResult;
  judge: ReviewAgentResult;
  initial: ParsedInitialReview;
  adjudication: ParsedJudgeReview;
}): ReviewFinding[] {
  const reviewerSource = toSource(input.reviewer);
  const judgeSource = toSource(input.judge);
  const merged: ReviewFinding[] = [];

  input.initial.findings.forEach((finding, index) => {
    const assessment = input.adjudication.assessments.find((candidate) => candidate.index === index + 1);
    const verdict = assessment?.verdict ?? "unverified";
    merged.push({
      id: findingId(input.round, merged.length + 1),
      ...finding,
      sources: verdict === "agree" ? [reviewerSource, judgeSource] : [reviewerSource],
      verdict,
      verdictReason: assessment?.reason ?? "The second model did not return a verdict for this finding.",
      consensus: verdict === "agree"
    });
  });

  for (const finding of input.adjudication.findings) {
    merged.push({
      id: findingId(input.round, merged.length + 1),
      ...finding,
      sources: [judgeSource],
      verdict: "unverified",
      verdictReason: "New finding added by the second model; it has not been cross-checked yet.",
      consensus: false
    });
  }
  return merged;
}

function readFindings(value: unknown): ParsedReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => normalizeFinding(item));
}

function normalizeFinding(value: unknown): ParsedReviewFinding[] {
  if (!isRecord(value)) return [];
  const title = readText(value.title, "").slice(0, 240);
  const evidence = readText(value.evidence, "").slice(0, 4000);
  const recommendation = readText(value.recommendation, "").slice(0, 4000);
  if (!title || !evidence || !recommendation) return [];
  const lineValue = Number(value.line);
  return [{
    severity: normalizeSeverity(value.severity),
    title,
    file: readNullableText(value.file)?.slice(0, 500) ?? null,
    line: Number.isInteger(lineValue) && lineValue > 0 ? lineValue : null,
    evidence,
    recommendation
  }];
}

function normalizeAssessment(value: unknown): ParsedAssessment[] {
  if (!isRecord(value)) return [];
  const index = Number(value.index);
  if (!Number.isInteger(index) || index < 1) return [];
  const verdict = value.verdict === "agree" || value.verdict === "disagree" || value.verdict === "uncertain"
    ? value.verdict
    : "uncertain";
  return [{ index, verdict, reason: readText(value.reason, "No reason provided.").slice(0, 2000) }];
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  const text = String(value ?? "").toLowerCase();
  if (text === "critical" || text === "p0") return "critical";
  if (text === "high" || text === "p1") return "high";
  if (text === "low" || text === "p3") return "low";
  return "medium";
}

function readJsonObject(response: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(response)?.[1]?.trim();
  for (const candidate of [fenced, response.trim(), extractFirstObject(response)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next representation.
    }
  }
  throw new Error("Review model returned invalid structured JSON. Run the review again.");
}

function extractFirstObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findingId(round: number, index: number): string {
  return `R${round}-${String(index).padStart(3, "0")}`;
}

function toSource(result: ReviewAgentResult): ReviewSource {
  return { engine: result.engine, provider: result.provider, model: result.model };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
