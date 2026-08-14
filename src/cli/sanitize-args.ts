export function redactCodexProxyCommandArgs(command: string | undefined, args: string[]): string[] | null {
  if (command !== "set" || args[0] !== "codex" || args[1] !== "proxy" || args.length < 3) {
    return null;
  }
  return [args[0], args[1], "[proxy-redacted]", ...args.slice(3)];
}
