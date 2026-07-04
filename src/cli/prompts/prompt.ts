import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function promptText(message: string, options: { defaultValue?: string; secret?: boolean } = {}): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = options.defaultValue ? ` (${options.defaultValue})` : "";
    const answer = await rl.question(`${message}${suffix}: `);
    return answer.trim() || options.defaultValue || "";
  } finally {
    rl.close();
  }
}

export async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  const fallback = defaultValue ? "Y/n" : "y/N";
  const answer = (await promptText(`${message} [${fallback}]`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

export async function promptSelect<T extends string | number>(
  message: string,
  choices: Array<{ label: string; value: T }>
): Promise<T> {
  if (!choices.length) {
    throw new Error(`No choices available for: ${message}`);
  }

  console.log(`\n${message}`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label}`);
  });

  while (true) {
    const raw = await promptText("Select");
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1]!.value;
    }
    console.log(`Please enter a number between 1 and ${choices.length}.`);
  }
}
