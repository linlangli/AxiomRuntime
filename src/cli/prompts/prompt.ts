import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";

export async function promptText(message: string, options: { defaultValue?: string; secret?: boolean } = {}): Promise<string> {
  let muted = false;
  const secretOutput = new Writable({ write(chunk, encoding, callback) { if (!muted) output.write(chunk, encoding); callback(); } });
  const rl = readline.createInterface({ input, output: options.secret ? secretOutput : output, terminal: options.secret ? Boolean(input.isTTY && output.isTTY) : undefined });
  try {
    const suffix = options.defaultValue && !options.secret ? ` (${options.defaultValue})` : "";
    const pending = rl.question(`${message}${suffix}: `);
    muted = Boolean(options.secret);
    const answer = await pending;
    return answer.trim() || options.defaultValue || "";
  } finally {
    rl.close();
    if (options.secret) output.write("\n");
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
  choices: Array<{ label: string; value: T; key?: string }>
): Promise<T> {
  if (!choices.length) {
    throw new Error(`No choices available for: ${message}`);
  }

  // 选项自带 key 时用 key 作为输入标识，避免“行号 + 取值”两套数字并列造成误选。
  const keyed = choices.every((choice) => choice.key !== undefined)
    && new Set(choices.map((choice) => choice.key)).size === choices.length;

  console.log(`\n${message}`);
  choices.forEach((choice, index) => {
    console.log(`  ${keyed ? choice.key : index + 1}. ${choice.label}`);
  });

  while (true) {
    const raw = await promptText("Select");
    if (keyed) {
      const matched = choices.find((choice) => choice.key === raw);
      if (matched) return matched.value;
      console.log(`Please enter one of: ${choices.map((choice) => choice.key).join(", ")}.`);
      continue;
    }
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1]!.value;
    }
    console.log(`Please enter a number between 1 and ${choices.length}.`);
  }
}
