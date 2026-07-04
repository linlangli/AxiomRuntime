import { spawn } from "node:child_process";
import { generateProjectContext } from "../../core/context/context-service.js";
import { writeLog } from "../../core/logs/log-service.js";

export async function runContextCommand(args: string[]): Promise<void> {
  const shouldPrint = args.includes("--print");
  const context = await generateProjectContext();
  await writeLog({
    category: "usage",
    action: "context_generated",
    message: `Generated project context: ${context.filePath}`,
    metadata: { filePath: context.filePath, printed: shouldPrint }
  });

  if (shouldPrint) {
    console.log(context.content);
    return;
  }

  await openFile(context.filePath);
  console.log(`Opened context file: ${context.filePath}`);
}

async function openFile(filePath: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];

  await new Promise<void>((resolve) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    child.unref();
  });
}
