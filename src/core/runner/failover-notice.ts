import type { CliToolType } from "../types.js";
import type { OpenAiUsageProxyFailoverEvent, OpenAiUsageProxyRoute } from "./openai-usage-types.js";

export function formatRouteLabel(route: OpenAiUsageProxyRoute): string {
  return `${route.provider.name}/${route.model}`;
}

/** 单次切换的用户可读描述，供流内提示与执行结束后的汇总共用同一套措辞。 */
export function describeFailoverEvent(event: OpenAiUsageProxyFailoverEvent): string {
  const from = formatRouteLabel(event.from);
  const to = formatRouteLabel(event.to);
  if (event.type === "automatic") {
    return `${from} 在产生有效输出前失败（${event.reason}），已自动切换到 ${to}`;
  }
  if (event.type === "confirmation_required") {
    return `${from} 已输出部分内容后中断（${event.reason}）。为避免重复输出与重复工具调用，Runtime 不会自动重放；重新提交或重试本次请求即确认切换到 ${to}`;
  }
  return `已确认切换到 ${to}，本次请求沿用当前会话上下文`;
}

/**
 * 原生 CLI 的 TUI 独占终端并整屏重绘，父进程写入会撞进渲染帧。
 * 因此会话期间的提示改为走协议内的 SSE error 事件，由 CLI 自己排版渲染。
 */
export function buildFailoverSseNotice(engine: CliToolType, event: OpenAiUsageProxyFailoverEvent): string {
  const message = `[AxiomRuntime] ${describeFailoverEvent(event)}`;
  const payload = engine === "claude"
    ? { type: "error", error: { type: "api_error", message } }
    : { type: "error", code: "provider_failover_pending", message, param: null };
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 执行结束、终端所有权归还父进程后打印的汇总；没有切换时返回 null。 */
export function formatFailoverSummary(events: readonly OpenAiUsageProxyFailoverEvent[]): string | null {
  if (!events.length) return null;
  const appliedCount = events.filter((event) => event.type !== "confirmation_required").length;
  const header = appliedCount
    ? `[AxiomRuntime] 本次执行发生 ${appliedCount} 次 provider 切换：`
    : "[AxiomRuntime] 本次执行出现 provider 切换提示：";
  const lines = events.map((event, index) => `  ${index + 1}. ${describeFailoverEvent(event)}`);
  return [header, ...lines, "  查看完整链路：ai log --print --trace <traceId>"].join("\n");
}
