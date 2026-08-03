export type CliCommand = {
  name: string;
  aliases?: string[];
  description: string;
  interactive?: boolean;
  logUsage?: boolean;
  run(args: string[]): Promise<void>;
};

const commands = new Map<string, CliCommand>();

export function registerCliCommand(command: CliCommand): void {
  commands.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    commands.set(alias, command);
  }
}

export function getCliCommand(name: string): CliCommand | undefined {
  return commands.get(name);
}

export function listCliCommands(): CliCommand[] {
  return [...new Set(commands.values())];
}

export function listInteractiveCliCommands(): CliCommand[] {
  return listCliCommands().filter((command) => command.interactive !== false);
}
