import { createApiServiceManager, type ApiServiceAction } from "../../core/services/api-service.js";

export async function runServerCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  if (args.length > 1 || !["status", "start", "stop", "restart", "enable", "disable"].includes(action)) throw new Error("Usage: ai server [status|start|stop|restart|enable|disable]");
  const manager = createApiServiceManager();
  const result = action === "status" ? await manager.status() : await manager.control(action as ApiServiceAction);
  console.log(JSON.stringify(result, null, 2));
}
