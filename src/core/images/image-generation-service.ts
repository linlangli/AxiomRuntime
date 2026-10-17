import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isProviderCircuitOpen, readCache, recordProviderRuntimeFailure, recordProviderRuntimeSuccess } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { writeLog } from "../logs/log-service.js";
import { startOpenAiUsageProxy } from "../runner/openai-usage-proxy.js";
import type { Provider } from "../types.js";
import { isRecord } from "../utils/is-record.js";

const IMAGE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_IMAGES = 8;
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024;

export type ImageProviderCandidate = {
  provider: Provider;
  model: string;
};

export type ImageProviderSelection = {
  providerName?: string;
  model?: string;
};

export type GeneratedImage = {
  provider: string;
  model: string;
  revisedPrompt?: string;
  filePath?: string;
  url?: string;
};

type ReferenceImage = { bytes: Uint8Array<ArrayBuffer>; mimeType: string; fileName: string };

export async function resolveImageProviderCandidates(
  selection: string | ImageProviderSelection,
  allowFallback = true
): Promise<ImageProviderCandidate[]> {
  const target = typeof selection === "string" ? selection.trim() : "";
  let providerName = typeof selection === "string" ? "" : selection.providerName?.trim() ?? "";
  let requestedModel = typeof selection === "string" ? "" : selection.model?.trim() ?? "";
  if (!target && !providerName && !requestedModel) throw new Error("Image provider or model is required.");

  const [providers, cache] = await Promise.all([readProviders(), readCache()]);
  if (!providers.length) {
    throw new Error("No providers configured. Run `ai add` first.");
  }

  if (target) {
    const targetProvider = providers.find((provider) => provider.name === target);
    if (targetProvider) providerName = targetProvider.name;
    else requestedModel = target;
  }
  const preferredProvider = providerName ? providers.find((provider) => provider.name === providerName) : undefined;
  if (providerName && !preferredProvider) {
    throw new Error(`Provider not found: ${providerName}`);
  }
  const targetModel = requestedModel || preferredProvider?.model.trim() || "";
  if (!targetModel) {
    throw new Error(`Provider ${providerName} has no default image model. Configure its model first.`);
  }

  const candidates = providers.flatMap((provider) => {
    const cached = cache.providers[provider.name];
    if (isProviderCircuitOpen(cached)) return [];
    if (cached?.status === "error" && !cached.circuitOpenUntil) return [];
    const knownModels = cached?.models ?? [];
    const offersModel = knownModels.includes(targetModel)
      || (!knownModels.length && provider.model === targetModel);
    return offersModel ? [{ provider, model: targetModel }] : [];
  });
  if (!preferredProvider) return allowFallback ? candidates : candidates.slice(0, 1);
  if (!allowFallback) return candidates.filter((candidate) => candidate.provider.name === preferredProvider.name);
  return [
    ...candidates.filter((candidate) => candidate.provider.name === preferredProvider.name),
    ...candidates.filter((candidate) => candidate.provider.name !== preferredProvider.name)
  ];
}

export async function generateImage(input: {
  target?: string;
  provider?: string;
  model?: string;
  prompt: string;
  outputDir?: string;
  /** Legacy single local reference; mutually exclusive with imagePaths. */
  imagePath?: string;
  /** Ordered local references: 1–8 files, <=20 MiB each and <=40 MiB total.
   * Validate all files before upload; never retry or fall back with references. */
  imagePaths?: string[];
}): Promise<GeneratedImage> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Image prompt is required.");
  if (input.imagePath !== undefined && input.imagePaths !== undefined) {
    throw new Error("Use either imagePath or imagePaths, not both.");
  }
  const paths = input.imagePaths ?? (input.imagePath !== undefined ? [input.imagePath] : []);
  if (input.imagePaths && !paths.length) throw new Error("At least one reference image path is required.");
  if (paths.length > MAX_REFERENCE_IMAGES) throw new Error("At most 8 reference images are supported.");
  const references: ReferenceImage[] = [];
  let totalBytes = 0;
  for (const imagePath of paths) {
    const reference = await readReferenceImage(imagePath);
    totalBytes += reference.bytes.byteLength;
    if (totalBytes > MAX_REFERENCE_BYTES) throw new Error("Reference images exceed 40 MiB in total.");
    references.push(reference);
  }

  const selection = input.target ?? { providerName: input.provider, model: input.model };
  const candidates = await resolveImageProviderCandidates(selection, !references.length);
  if (!candidates.length) {
    const selectionName = input.target ?? input.provider ?? input.model ?? "(unknown)";
    throw new Error(`No usable provider offers image model for ${selectionName}. Run \`ai status\` to refresh model lists.`);
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await generateWithProvider(candidate, prompt, input.outputDir ?? process.cwd(), references);
      await recordProviderRuntimeSuccess(candidate.provider.name);
      return result;
    } catch (error) {
      const message = summarizeError(error);
      failures.push(`${candidate.provider.name}: ${message}`);
      await recordProviderRuntimeFailure(candidate.provider.name, message);
      await writeLog({
        level: "warn",
        category: "provider",
        action: "image_generation_provider_failed",
        message: `Image generation failed for ${candidate.provider.name} / ${candidate.model}: ${message}`,
        metadata: { provider: candidate.provider.name, model: candidate.model }
      });
    }
  }

  throw new Error(`Image generation failed. ${failures.join("; ")}`);
}

async function generateWithProvider(
  candidate: ImageProviderCandidate,
  prompt: string,
  outputDir: string,
  references: ReferenceImage[]
): Promise<GeneratedImage> {
  const usageProxy = await startOpenAiUsageProxy({
    provider: candidate.provider,
    model: candidate.model,
    tool: "image",
    engine: "codex",
    upstreamHeadersTimeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
    ...(references.length ? { maxAttemptsPerRoute: 1 } : {})
  });

  try {
    let body: string | FormData = JSON.stringify({ model: candidate.model, prompt, n: 1 });
    if (references.length) {
      const form = new FormData();
      form.set("model", candidate.model);
      form.set("prompt", prompt);
      form.set("n", "1");
      references.forEach((reference, index) => {
        const multiple = references.length > 1;
        const fileName = multiple ? reference.fileName.replace("reference.", `reference-${index + 1}.`) : reference.fileName;
        form.append(multiple ? "image[]" : "image", new Blob([reference.bytes], { type: reference.mimeType }), fileName);
      });
      body = form;
    }
    const response = await fetchWithTimeout(`${usageProxy.baseUrl}/images/${references.length ? "edits" : "generations"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${candidate.provider.apiKey}`,
        ...(references.length ? {} : { "content-type": "application/json" })
      },
      body
    });
    const text = await readBoundedResponseText(response, MAX_IMAGE_RESPONSE_BYTES);
    if (!response.ok && references.length && [404, 405, 415, 501].includes(response.status)) {
      throw new Error(`Provider does not support this image edit request (HTTP ${response.status}). Choose a provider/model supporting multipart /images/edits. The reference was not sent to fallback providers.`);
    }
    const payload = parseJsonResponse(text);
    if (!response.ok) {
      throw new Error(readProviderError(payload) ?? `Provider returned HTTP ${response.status}.`);
    }

    const image = readFirstImage(payload);
    if (!image) throw new Error("Provider response did not contain an image.");
    const baseResult = {
      provider: candidate.provider.name,
      model: candidate.model,
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {})
    };
    if (image.base64) {
      const buffer = decodeImage(image.base64);
      const extension = detectImageExtension(buffer);
      const filePath = await writeImageFile(outputDir, buffer, extension);
      await writeLog({
        category: "usage",
        action: "image_generated",
        message: `Generated image with ${candidate.provider.name} / ${candidate.model}.`,
        metadata: { provider: candidate.provider.name, model: candidate.model, filePath, bytes: buffer.length }
      });
      return { ...baseResult, filePath };
    }

    await writeLog({
      category: "usage",
      action: "image_generated_url",
      message: `Generated image URL with ${candidate.provider.name} / ${candidate.model}.`,
      metadata: { provider: candidate.provider.name, model: candidate.model, urlHost: new URL(image.url!).host }
    });
    return { ...baseResult, url: image.url };
  } finally {
    await usageProxy.close().catch(() => undefined);
  }
}

async function readReferenceImage(filePath: string): Promise<ReferenceImage> {
  if (!filePath.trim()) throw new Error("Local reference image path is required.");
  const file = await fs.open(path.resolve(filePath), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Reference image must be a regular local file.");
    if (stat.size > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds 20 MiB.");
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds 20 MiB.");
    const bytes = buffer.subarray(0, length);
    let extension: string;
    try { extension = detectImageExtension(bytes); }
    catch { throw new Error("Reference image must be PNG, JPEG, or WebP (detected from file content)."); }
    if (extension === "gif") throw new Error("Reference image must be PNG, JPEG, or WebP; GIF is not supported.");
    const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    return { bytes: Uint8Array.from(bytes), mimeType, fileName: `reference.${extension}` };
  } finally {
    await file.close();
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Provider image response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return "";

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`Provider image response exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Provider returned an invalid image response.");
  }
}

function readFirstImage(payload: unknown): { base64?: string; url?: string; revisedPrompt?: string } | null {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.data[0])) return null;
  const item = payload.data[0];
  const base64 = typeof item.b64_json === "string" && item.b64_json.trim() ? item.b64_json.trim() : undefined;
  const url = typeof item.url === "string" && isSafeImageUrl(item.url) ? item.url : undefined;
  const revisedPrompt = typeof item.revised_prompt === "string" && item.revised_prompt.trim()
    ? item.revised_prompt.trim()
    : undefined;
  if (!base64 && !url) return null;
  return { base64, url, revisedPrompt };
}

function isSafeImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function decodeImage(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Provider returned invalid base64 image data.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length) throw new Error("Provider returned an empty image.");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Generated image exceeds ${MAX_IMAGE_BYTES} bytes.`);
  return buffer;
}

function detectImageExtension(buffer: Buffer): "png" | "jpg" | "webp" | "gif" {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "gif";
  throw new Error("Provider returned an unsupported image format.");
}

async function writeImageFile(outputDir: string, buffer: Buffer, extension: string): Promise<string> {
  const resolvedDir = path.resolve(outputDir);
  await fs.mkdir(resolvedDir, { recursive: true });
  const fileName = `axiom-image-${formatTimestamp(new Date())}-${randomUUID().slice(0, 8)}.${extension}`;
  const filePath = path.join(resolvedDir, fileName);
  const temporaryPath = path.join(resolvedDir, `.${fileName}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporaryPath, buffer, { mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, filePath);
    return filePath;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function readProviderError(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 500);
  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim().slice(0, 500);
  }
  return typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim().slice(0, 500)
    : null;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Image request timed out.";
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
