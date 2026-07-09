export type ParsedToolName = {
  raw: string;
  name: string;
  kind: "builtin" | "mcp" | "command";
  mcpServer?: string;
};

const MAX_TOOL_PART_LENGTH = 24;

export function parseToolName(
  value: unknown,
  options: { kind?: ParsedToolName["kind"]; mcpServer?: string } = {}
): ParsedToolName {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "tool";
  if (options.kind === "mcp") {
    return {
      raw,
      name: truncateToolPart(raw),
      kind: "mcp",
      mcpServer: truncateToolPart(options.mcpServer || "mcp")
    };
  }
  if (options.kind === "command") {
    return {
      raw,
      name: truncateToolPart(raw),
      kind: "command"
    };
  }
  const mcp = raw.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    return {
      raw,
      name: truncateToolPart(mcp[2] || "tool"),
      kind: "mcp",
      mcpServer: truncateToolPart(mcp[1] || "mcp")
    };
  }
  return {
    raw,
    name: truncateToolPart(raw),
    kind: "builtin"
  };
}

export function truncateToolPart(value: string, maxLength = MAX_TOOL_PART_LENGTH): string {
  const text = value.trim() || "tool";
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}
