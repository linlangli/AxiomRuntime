import http, { type IncomingHttpHeaders } from "node:http";

const MAX_USAGE_CAPTURE_BYTES = 8 * 1024 * 1024;

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const RESPONSE_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length"
]);

export function buildUpstreamUrl(upstreamBaseUrl: string, incomingUrl: string): string {
  const local = new URL(incomingUrl, "http://127.0.0.1");
  let suffix = local.pathname;
  if (suffix === "/v1") {
    suffix = "";
  } else if (suffix.startsWith("/v1/")) {
    suffix = suffix.slice(3);
  }
  const upstream = new URL(`${upstreamBaseUrl.replace(/\/+$/, "")}${suffix}`);
  upstream.search = local.search;
  return upstream.toString();
}

export function buildUpstreamHeaders(headers: IncomingHttpHeaders, apiKey: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "host" || normalized === "content-length") continue;
    if (Array.isArray(value)) {
      next[key] = value.join(", ");
    } else if (typeof value === "string") {
      next[key] = value;
    }
  }
  next.authorization = `Bearer ${apiKey}`;
  next["accept-encoding"] = "identity";
  return next;
}

export function writeResponseHead(res: http.ServerResponse, response: Response): void {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  for (const [key, value] of response.headers.entries()) {
    if (!RESPONSE_HEADERS_TO_DROP.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
}

export async function streamResponse(response: Response, res: http.ServerResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  if (!response.body) return Buffer.alloc(0);

  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    if (capturedBytes < MAX_USAGE_CAPTURE_BYTES) {
      const remaining = MAX_USAGE_CAPTURE_BYTES - capturedBytes;
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      capturedBytes += Math.min(buffer.length, remaining);
    }
    res.write(buffer);
  }

  return Buffer.concat(chunks);
}

export async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function methodMayHaveBody(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
