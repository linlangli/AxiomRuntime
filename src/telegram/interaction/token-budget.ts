import { decode, encode } from "gpt-tokenizer";

export function countPromptTokens(value: string): number {
  return encode(value).length;
}

export function isWithinTokenBudget(value: string, maxTokens: number): boolean {
  return countPromptTokens(value) <= maxTokens;
}

export function truncateToTokenBudget(value: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const tokens = encode(value);
  if (tokens.length <= maxTokens) return value;
  const suffix = "...";
  const suffixTokens = encode(suffix);
  if (suffixTokens.length >= maxTokens) {
    return decode(suffixTokens.slice(0, maxTokens));
  }
  const bodyTokens = tokens.slice(0, maxTokens - suffixTokens.length);
  return `${decode(bodyTokens).trimEnd()}${suffix}`;
}
