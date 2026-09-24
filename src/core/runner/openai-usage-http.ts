import http, { type IncomingHttpHeaders } from "node:http";
import { buildProviderAuthHeaders } from "../providers/provider-request-profile.js";
import type { ProviderAuthScheme } from "../types.js";

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

export function buildUpstreamUrl(
  upstreamBaseUrl: string,
  incomingUrl: string,
  options: { stripV1Prefix?: boolean } = {}
): string {
  const local = new URL(incomingUrl, "http://127.0.0.1");
  let suffix = local.pathname;
  if (options.stripV1Prefix !== false) {
    if (suffix === "/v1") {
      suffix = "";
    } else if (suffix.startsWith("/v1/")) {
      suffix = suffix.slice(3);
    }
  }
  const upstream = new URL(`${upstreamBaseUrl.replace(/\/+$/, "")}${suffix}`);
  upstream.search = local.search;
  return upstream.toString();
}

export function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string,
  options: {
    includeAnthropicApiKey?: boolean;
    includeAuthorization?: boolean;
    authScheme?: ProviderAuthScheme;
    includeAnthropicVersion?: boolean;
  } = {}
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "host" || normalized === "content-length") continue;
    if (Array.isArray(value)) {
      next[normalized] = value.join(", ");
    } else if (typeof value === "string") {
      next[normalized] = value;
    }
  }
  delete next.authorization;
  delete next["x-api-key"];
  delete next["api-key"];
  if (options.authScheme) {
    Object.assign(next, buildProviderAuthHeaders(apiKey, options.authScheme));
  } else {
    if (options.includeAuthorization !== false) {
      next.authorization = `Bearer ${apiKey}`;
    }
    if (options.includeAnthropicApiKey) {
      next["x-api-key"] = apiKey;
    }
  }
  if (options.includeAnthropicVersion) {
    next["anthropic-version"] = "2023-06-01";
  }
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

export async function streamResponse(
  response: Response,
  res: http.ServerResponse,
  options: { maxCaptureBytes?: number } = {}
): Promise<Buffer> {
  const maxCaptureBytes = normalizeCaptureLimit(options.maxCaptureBytes);
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  const tailChunks: Buffer[] = [];
  let tailBytes = 0;
  let responseBytes = 0;
  const tailLimit = Math.floor(maxCaptureBytes / 2);
  if (!response.body) return Buffer.alloc(0);

  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    responseBytes += buffer.length;
    if (capturedBytes < maxCaptureBytes) {
      const remaining = maxCaptureBytes - capturedBytes;
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      capturedBytes += Math.min(buffer.length, remaining);
    }
    tailBytes = appendTailChunk(tailChunks, buffer, tailLimit, tailBytes);
    res.write(buffer);
  }

  const captured = Buffer.concat(chunks, capturedBytes);
  if (responseBytes <= maxCaptureBytes) return captured;
  return Buffer.concat([
    captured.subarray(0, tailLimit),
    Buffer.from("\n"),
    Buffer.concat(tailChunks, tailBytes)
  ]);
}

export type GatedStreamResult = {
  captured: Buffer;
  outputStarted: boolean;
  error: unknown | null;
};

export async function streamResponseWithGate(
  response: Response,
  res: http.ServerResponse,
  isEffectiveOutput: (buffer: Buffer) => boolean,
  options: { maxCaptureBytes?: number; maxPreludeBytes?: number } = {}
): Promise<GatedStreamResult> {
  const maxCaptureBytes = normalizeCaptureLimit(options.maxCaptureBytes);
  const maxPreludeBytes = options.maxPreludeBytes ?? 256 * 1024;
  const capturedChunks: Buffer[] = [];
  const tailChunks: Buffer[] = [];
  const preludeChunks: Buffer[] = [];
  let capturedBytes = 0;
  let tailBytes = 0;
  let responseBytes = 0;
  let preludeBytes = 0;
  let outputStarted = false;
  const tailLimit = Math.floor(maxCaptureBytes / 2);
  if (!response.body) {
    writeResponseHead(res, response);
    return { captured: Buffer.alloc(0), outputStarted: false, error: null };
  }

  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      responseBytes += buffer.length;
      if (capturedBytes < maxCaptureBytes) {
        const remaining = maxCaptureBytes - capturedBytes;
        capturedChunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
        capturedBytes += Math.min(buffer.length, remaining);
      }
      tailBytes = appendTailChunk(tailChunks, buffer, tailLimit, tailBytes);

      if (!outputStarted) {
        preludeChunks.push(buffer);
        preludeBytes += buffer.length;
        const prelude = Buffer.concat(preludeChunks, preludeBytes);
        if (preludeBytes >= maxPreludeBytes || isEffectiveOutput(prelude)) {
          writeResponseHead(res, response);
          for (const pending of preludeChunks) res.write(pending);
          preludeChunks.length = 0;
          outputStarted = true;
        }
      } else {
        res.write(buffer);
      }
    }
  } catch (error) {
    return { captured: buildCapturedResponse(capturedChunks, capturedBytes, tailChunks, tailBytes, responseBytes, maxCaptureBytes), outputStarted, error };
  }

  if (!outputStarted) {
    writeResponseHead(res, response);
    for (const pending of preludeChunks) res.write(pending);
  }
  return {
    captured: buildCapturedResponse(capturedChunks, capturedBytes, tailChunks, tailBytes, responseBytes, maxCaptureBytes),
    outputStarted,
    error: null
  };
}

function buildCapturedResponse(
  chunks: Buffer[],
  capturedBytes: number,
  tailChunks: Buffer[],
  tailBytes: number,
  responseBytes: number,
  limit: number
): Buffer {
  const captured = Buffer.concat(chunks, capturedBytes);
  if (responseBytes <= limit) return captured;
  const half = Math.floor(limit / 2);
  return Buffer.concat([captured.subarray(0, half), Buffer.from("\n"), Buffer.concat(tailChunks, tailBytes)]);
}

function normalizeCaptureLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return MAX_USAGE_CAPTURE_BYTES;
  return Math.max(1024, Math.floor(value));
}

function appendTailChunk(
  chunks: Buffer[],
  buffer: Buffer,
  limit: number,
  currentBytes: number
): number {
  if (buffer.length >= limit) {
    chunks.splice(0, chunks.length, buffer.subarray(buffer.length - limit));
    return limit;
  }

  chunks.push(buffer);
  let bytes = currentBytes + buffer.length;
  while (chunks.length && bytes - chunks[0]!.length >= limit) {
    bytes -= chunks.shift()!.length;
  }
  if (bytes > limit && chunks.length) {
    const excess = bytes - limit;
    chunks[0] = chunks[0]!.subarray(excess);
    bytes = limit;
  }
  return bytes;
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
