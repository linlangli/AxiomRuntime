import { spawn } from "node:child_process";
import { getUsageHtmlPath } from "../../core/config/paths.js";

export async function runHelpCommand(): Promise<void> {
  const filePath = getUsageHtmlPath();
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];

  await new Promise<void>((resolve) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.log(filePath);
      resolve();
    });
    child.on("close", () => resolve());
    child.unref();
  });
}
