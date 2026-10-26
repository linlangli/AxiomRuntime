import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { planImageGeneration, validateImageModelSize, type ImagePlanInput } from "./image-generation-plan.js";
import type { OpenAiUsageProxy } from "../runner/openai-usage-types.js";
import { isProviderCircuitOpen, readCache, recordProviderRuntimeFailure, recordProviderRuntimeSuccess } from "../config/cache-store.js";
import { readProviders } from "../config/providers-store.js";
import { writeLog } from "../logs/log-service.js";
import { startOpenAiUsageProxy } from "../runner/openai-usage-proxy.js";
import type { Provider } from "../types.js";
import { isRecord } from "../utils/is-record.js";

const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 600_000;
const MAX_IMAGE_REQUEST_TIMEOUT_MS = 2_147_483_647;
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
  requestedSize?: string;
  actualSize?: string;
  warning?: string;
  revisedPrompt?: string;
  filePath?: string;
  url?: string;
  recoveryPath?: string;
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

export type GenerateImageInput = {
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
  size?: string;
};

export type ImageTaskResult = { index: number; size?: string; images: GeneratedImage[]; error?: string; recoveryPath?: string };
export type ImageGenerationBatch = { tasks: ImageTaskResult[]; images: GeneratedImage[]; success: boolean };

class PartialImageOutputError extends Error {
  constructor(message: string, readonly images: GeneratedImage[]) { super(message); }
}

type ImageRecoveryRecord = {
  version: 1;
  status: "pending" | "completed";
  createdAt: string;
  provider: string;
  model: string;
  size?: string;
  responseStatus?: number;
  responseContentType?: string;
  responseText?: string;
};

type ImageRecoveryContext = { path: string; provider: string; model: string; size?: string };

function imageRequestTimeoutMs(): number {
  const raw = process.env.AI_GATEWAY_IMAGE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_IMAGE_REQUEST_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new Error("AI_GATEWAY_IMAGE_TIMEOUT_MS must be a positive integer in milliseconds.");
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_IMAGE_REQUEST_TIMEOUT_MS) {
    throw new Error(`AI_GATEWAY_IMAGE_TIMEOUT_MS must be between 1 and ${MAX_IMAGE_REQUEST_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

/** Sequential multi-output execution sharing one Transport Proxy and its authoritative UsageObserver.
 * Each task requests n=1. Completed outputs are retained if another task fails; no batch replay.
 * Unknown provider size constraints are validated by the upstream API, never silently substituted.
 */
export async function generateImages(input: GenerateImageInput & ImagePlanInput): Promise<ImageGenerationBatch> {
  const timeoutMs = imageRequestTimeoutMs();
  const plan = planImageGeneration(input);
  const references = await readReferences(input);
  const outputDir = resolveImageOutputDir(input.outputDir);
  const recoveryDir = await prepareImageOutput(outputDir);
  const candidates = await resolveImageProviderCandidates(
    input.target ?? { providerName: input.provider, model: input.model },
    false
  );
  if (!candidates.length) throw new Error("No usable image provider. Run `ai status` to refresh model lists.");
  for (const task of plan) validateImageModelSize(candidates[0]!.model, task.size);
  const active = candidates[0]!;
  let currentRecovery: ImageRecoveryContext | undefined;
  const proxy = await startOpenAiUsageProxy({
    provider: active.provider, model: active.model, tool: "image", engine: "codex",
    upstreamHeadersTimeoutMs: timeoutMs,
    maxAttemptsPerRoute: 1,
    onRouteResult: async (route, success, reason) => {
      if (!success) await recordProviderRuntimeFailure(route.provider.name, reason ?? "image_request_failed");
    },
    onBufferedResponse: async (response, route, requestModel) => {
      if (currentRecovery) await completeImageRecovery(currentRecovery, response, route, requestModel);
    }
  });
  const tasks: ImageTaskResult[] = [];
  try {
    for (const task of plan) {
      const remaining = 8 - tasks.reduce((count, task) => count + task.images.length, 0);
      if (remaining <= 0) {
        tasks.push({ index: task.index, size: task.size, images: [], error: "Output limit reached because the provider returned extra images." });
        continue;
      }
      let preserveRecoveryForLateResponse = false;
      try {
        const recovery = await createPendingImageRecovery(recoveryDir, active, task.size);
        currentRecovery = recovery;
        const images = await generateWithProvider(active, task.prompt, outputDir, references, task.size, {
          proxy, getCandidate: () => active, index: task.index, remaining, recovery, timeoutMs
        });
        await recordProviderRuntimeSuccess(active.provider.name);
        const mismatch = images.filter((image) => image.actualSize && task.size && task.size !== "auto" && image.actualSize !== task.size);
        tasks.push({ index: task.index, size: task.size, images, recoveryPath: recovery.path,
          ...(mismatch.length ? { error: "Provider returned a different image size; saved outputs were retained." } : {}) });
      } catch (error) {
        preserveRecoveryForLateResponse = isImageRequestAbort(error);
        const message = summarizeError(error);
        const recoveryPath = currentRecovery?.path;
        tasks.push({ index: task.index, size: task.size, images: error instanceof PartialImageOutputError ? error.images : [], error: appendRecoveryHint(message, recoveryPath), ...(recoveryPath ? { recoveryPath } : {}) });
        await writeLog({ category: "provider", level: "warn", action: "image_generation_task_failed",
          message: "Image generation task failed.", metadata: { index: task.index, provider: active.provider.name, model: active.model, size: task.size } });
      } finally {
        if (!preserveRecoveryForLateResponse) currentRecovery = undefined;
      }
      if (preserveRecoveryForLateResponse) break;
    }
    return { tasks, images: tasks.flatMap((task) => task.images), success: tasks.every((task) => !task.error) };
  } finally {
    await proxy.close().catch(() => undefined);
  }
}

/** Backward-compatible single-output API; CLI batch planning lives in generateImages. */
export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const timeoutMs = imageRequestTimeoutMs();
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Image prompt is required.");
  const references = await readReferences(input);
  const outputDir = resolveImageOutputDir(input.outputDir);
  const recoveryDir = await prepareImageOutput(outputDir);
  if (input.size) validateImageModelSize(input.model ?? "", input.size);

  const selection = input.target ?? { providerName: input.provider, model: input.model };
  const candidates = await resolveImageProviderCandidates(selection, false);
  if (!candidates.length) {
    const selectionName = input.target ?? input.provider ?? input.model ?? "(unknown)";
    throw new Error(`No usable provider offers image model for ${selectionName}. Run \`ai status\` to refresh model lists.`);
  }

  const candidate = candidates[0]!;
  const recovery = await createPendingImageRecovery(recoveryDir, candidate, input.size);
  try {
    const result = await generateWithProvider(candidate, prompt, outputDir, references, input.size, { recovery, timeoutMs });
    await recordProviderRuntimeSuccess(candidate.provider.name);
    return result[0]!;
  } catch (error) {
    const message = summarizeError(error);
    await recordProviderRuntimeFailure(candidate.provider.name, message);
    await writeLog({ level: "warn", category: "provider", action: "image_generation_provider_failed",
      message: `Image generation failed for ${candidate.provider.name} / ${candidate.model}: ${message}`,
      metadata: { provider: candidate.provider.name, model: candidate.model } });
    throw new Error(appendRecoveryHint(`Image generation failed: ${message}`, recovery.path));
  }
}

async function readReferences(input: GenerateImageInput): Promise<ReferenceImage[]> {
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

  return references;
}

async function generateWithProvider(
  candidate: ImageProviderCandidate,
  prompt: string,
  outputDir: string,
  references: ReferenceImage[],
  size?: string,
  shared?: { proxy?: OpenAiUsageProxy; getCandidate?: () => ImageProviderCandidate; index?: number; remaining?: number; recovery: ImageRecoveryContext; timeoutMs: number }
): Promise<GeneratedImage[]> {
  const recovery = shared?.recovery;
  const usageProxy = shared?.proxy ?? await startOpenAiUsageProxy({
    provider: candidate.provider, model: candidate.model, tool: "image", engine: "codex",
    upstreamHeadersTimeoutMs: shared?.timeoutMs ?? imageRequestTimeoutMs(), maxAttemptsPerRoute: 1,
    onBufferedResponse: recovery
      ? (response, route, requestModel) => completeImageRecovery(recovery, response, route, requestModel)
      : undefined
  });

  try {
    let body: string | FormData = JSON.stringify({ model: candidate.model, prompt, n: 1, ...(size ? { size } : {}) });
    if (references.length) {
      const form = new FormData();
      form.set("model", candidate.model);
      form.set("prompt", prompt);
      form.set("n", "1");
      if (size) form.set("size", size);
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
    }, shared?.timeoutMs ?? imageRequestTimeoutMs());
    const text = await readBoundedResponseText(response, MAX_IMAGE_RESPONSE_BYTES);
    if (!response.ok && references.length && [404, 405, 415, 501].includes(response.status)) {
      throw new Error(`Provider does not support this image edit request (HTTP ${response.status}). Choose a provider/model supporting multipart /images/edits. The reference was not sent to fallback providers.`);
    }
    const payload = parseJsonResponse(text);
    if (!response.ok) {
      throw new Error(readProviderError(payload) ?? `Provider returned HTTP ${response.status}.`);
    }

    const images = readImages(payload);
    if (shared?.remaining !== undefined && images.length > shared.remaining) throw new Error("Provider response exceeds the remaining 8-image output limit.");
    if (!images.length) throw new Error("Provider response did not contain an image.");
    const routed = shared?.getCandidate?.() ?? candidate;
    // Validate the entire response before writing any files.
    const results: GeneratedImage[] = [];
    try {
      const saved = await saveImagePayload(images, routed.provider.name, routed.model, outputDir, size,
        recovery?.path, shared?.index !== undefined ? `${shared.index}` : undefined);
      for (const result of saved) {
        results.push(result);
        await writeLog({ category: "usage", action: result.filePath ? "image_generated" : "image_generated_url",
          message: `Generated image with ${routed.provider.name} / ${routed.model}.`,
          metadata: { provider: routed.provider.name, model: routed.model, index: shared?.index,
            ...(result.filePath ? { filePath: result.filePath } : { urlHost: new URL(result.url!).host }),
            recoveryPath: recovery?.path,
            requestedSize: size, actualSize: result.actualSize } });
      }
    } catch (error) {
      throw new PartialImageOutputError(summarizeError(error), [
        ...results,
        ...(error instanceof PartialImageOutputError ? error.images : [])
      ]);
    }
    return results;
  } finally {
    if (!shared) await usageProxy.close().catch(() => undefined);
  }
}

export async function recoverGeneratedImages(responseFile: string, outputDir?: string): Promise<GeneratedImage[]> {
  const record = JSON.parse(await fs.readFile(path.resolve(responseFile), "utf8")) as Partial<ImageRecoveryRecord>;
  if (record.version !== 1 || record.status !== "completed" || typeof record.responseText !== "string") {
    throw new Error("This recovery record is pending or incomplete; do not resubmit the request automatically.");
  }
  if (typeof record.provider !== "string" || typeof record.model !== "string") throw new Error("Invalid image recovery record.");
  const payload = parseJsonResponse(record.responseText);
  return saveImagePayload(readImages(payload), record.provider, record.model, resolveImageOutputDir(outputDir), record.size, path.resolve(responseFile));
}

export function resolveImageOutputDir(outputDir?: string): string {
  return outputDir ?? process.cwd();
}

async function prepareImageOutput(outputDir: string): Promise<string> {
  const resolvedDir = path.resolve(outputDir);
  await fs.mkdir(resolvedDir, { recursive: true, mode: 0o700 });
  if (!(await fs.stat(resolvedDir)).isDirectory()) throw new Error("Image output path must be a directory.");
  const recoveryDir = path.join(resolvedDir, ".ai-image-recovery");
  await fs.mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  await fs.chmod(recoveryDir, 0o700).catch(() => undefined);
  const probe = path.join(recoveryDir, `.probe-${process.pid}-${randomUUID()}`);
  await fs.writeFile(probe, "", { mode: 0o600, flag: "wx" });
  await fs.rm(probe, { force: true });
  return recoveryDir;
}

async function createPendingImageRecovery(recoveryDir: string, candidate: ImageProviderCandidate, size?: string): Promise<ImageRecoveryContext> {
  const filePath = path.join(recoveryDir, `image-response-${formatTimestamp(new Date())}-${randomUUID()}.json`);
  const record: ImageRecoveryRecord = {
    version: 1, status: "pending", createdAt: new Date().toISOString(), provider: candidate.provider.name, model: candidate.model,
    ...(size ? { size } : {})
  };
  await writeRecoveryRecord(filePath, record);
  return { path: filePath, provider: candidate.provider.name, model: candidate.model, ...(size ? { size } : {}) };
}

async function completeImageRecovery(recovery: ImageRecoveryContext, response: { status: number; statusText: string; contentType: string; body: Buffer }, route: ImageProviderCandidate, requestModel: string): Promise<void> {
  await writeRecoveryRecord(recovery.path, {
    version: 1, status: "completed", createdAt: new Date().toISOString(), provider: route.provider.name, model: requestModel,
    ...(recovery.size ? { size: recovery.size } : {}), responseStatus: response.status, responseContentType: response.contentType,
    responseText: response.body.toString("utf8")
  });
}

async function writeRecoveryRecord(filePath: string, record: ImageRecoveryRecord): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try { await fs.rename(temporaryPath, filePath); }
  catch (error) { await fs.rm(temporaryPath, { force: true }).catch(() => undefined); throw error; }
}

async function saveImagePayload(images: { base64?: string; url?: string; revisedPrompt?: string }[], provider: string, model: string, outputDir: string, size?: string, recoveryPath?: string, label?: string): Promise<GeneratedImage[]> {
  const decoded = images.map((image) => {
    if (!image.base64) return { image };
    const buffer = decodeImage(image.base64);
    const extension = detectImageExtension(buffer);
    let actualSize: string | undefined;
    if (size && size !== "auto") {
      try { const dimensions = imageSize(buffer); actualSize = `${dimensions.width}x${dimensions.height}`; }
      catch { throw new Error("Cannot verify generated image dimensions."); }
    }
    return { image, buffer, extension, actualSize };
  });
  const results: GeneratedImage[] = [];
  for (const [offset, entry] of decoded.entries()) {
    const result: GeneratedImage = { provider, model, ...(recoveryPath ? { recoveryPath } : {}), ...(size ? { requestedSize: size } : {}), ...(entry.actualSize ? { actualSize: entry.actualSize } : {}), ...(entry.image.revisedPrompt ? { revisedPrompt: entry.image.revisedPrompt } : {}) };
    try {
      if (entry.buffer && entry.extension) {
        result.filePath = await writeImageFile(outputDir, entry.buffer, entry.extension, label ? `${label}-${offset + 1}${size ? `-${size}` : ""}` : undefined);
        if (entry.actualSize && entry.actualSize !== size) result.warning = `Requested ${size}, received ${entry.actualSize}.`;
      } else {
        result.url = entry.image.url;
        if (size && size !== "auto") result.warning = "Remote URL size is unverified; the image was not downloaded.";
      }
    } catch (error) {
      throw new PartialImageOutputError(summarizeError(error), results);
    }
    results.push(result);
  }
  return results;
}

function appendRecoveryHint(message: string, recoveryPath?: string): string {
  return recoveryPath ? `${message} Check recovery record: ${recoveryPath}. Do not resubmit until it is checked.` : message;
}

function isImageRequestAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = imageRequestTimeoutMs()): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function readImages(payload: unknown): { base64?: string; url?: string; revisedPrompt?: string }[] {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.length) return [];
  if (payload.data.length > 8) throw new Error("Provider returned more than 8 images in one response.");
  return payload.data.map((item) => {
    if (!isRecord(item)) throw new Error("Provider returned an invalid image item.");
    const base64 = typeof item.b64_json === "string" && item.b64_json.trim() ? item.b64_json.trim() : undefined;
    const url = typeof item.url === "string" && isSafeImageUrl(item.url) ? item.url : undefined;
    const revisedPrompt = typeof item.revised_prompt === "string" && item.revised_prompt.trim() ? item.revised_prompt.trim() : undefined;
    if (!base64 && !url) throw new Error("Provider returned an invalid image item.");
    return { base64, url, revisedPrompt };
  });
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

async function writeImageFile(outputDir: string, buffer: Buffer, extension: string, label?: string): Promise<string> {
  const resolvedDir = path.resolve(outputDir);
  await fs.mkdir(resolvedDir, { recursive: true });
  const fileName = `axiom-image-${formatTimestamp(new Date())}-${label ? `${label}-` : ""}${randomUUID().slice(0, 8)}.${extension}`;
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
  if (error instanceof Error && error.name === "AbortError") return "Image request timed out; upstream result and billing status are unknown.";
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
