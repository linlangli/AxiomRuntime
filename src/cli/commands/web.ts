import { spawn } from "node:child_process";
import { startLocalWebServer } from "../../web/local-server.js";

export async function runWebCommand(args: string[]): Promise<void> {
  if (args.length) throw new Error("Usage: ai web");
  const server = await startLocalWebServer();
  console.log(`AxiomRuntime control panel: ${server.url}`);
  console.log("Press Ctrl+C to close the local control panel.");
  openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const close = () => { void server.close().finally(resolve); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}
