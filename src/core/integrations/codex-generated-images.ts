import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { imageSize } from "image-size";
import { isRecord } from "../utils/is-record.js";

export type CodexGeneratedImage = { bytes: Buffer; filename: string; photo: boolean };
export type CodexImageResult = { images: CodexGeneratedImage[]; notice?: string };
type Rollout = { file: string; offset: number };

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function findImageRollout(home: string, threadId: string): Promise<Rollout | undefined> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) return;
  for await (const name of fs.glob(`sessions/*/*/*/rollout-*-${threadId}.jsonl`, { cwd: home })) {
    const file = path.join(home, name);
    const stat = await fs.lstat(file);
    if (stat.isFile()) return { file, offset: stat.size };
  }
}

async function imageBytes(item: Record<string, unknown>, home: string, threadId: string, budget: number) {
  if (typeof item.result === "string" && item.result) {
    if (item.result.length > 4 * Math.ceil(budget / 3)) return;
    return Buffer.from(item.result, "base64");
  }
  // Newer rollouts can replace inline bytes with an attachment-store reference.
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.id)) return;
  const root = await fs.realpath(home);
  const file = path.join(root, "generated_images", threadId, `${item.id}.png`);
  const expected = path.join(home, "generated_images", threadId, `${item.id}.png`);
  if ((item.savedPath !== expected && item.savedPath !== file) || await fs.realpath(file) !== file) return;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (stat.isFile() && stat.nlink === 1 && stat.size <= budget) return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// exec --json omits image-generation items. Match the native user turn before consuming its tool results.
export async function readCodexTurnImages(
  home: string, threadId: string, prompt: string, previous?: Rollout
): Promise<CodexImageResult> {
  const result: CodexImageResult = { images: [] };
  const rollout = await findImageRollout(home, threadId);
  if (!rollout) return { ...result, notice: "未找到本次 Codex 会话记录，无法读取生图结果。" };
  const start = previous?.file === rollout.file && previous.offset <= rollout.offset ? previous.offset : 0;
  const stream = createReadStream(rollout.file, { start });
  let turnId: string | undefined;
  let failed = false;
  let budget = MAX_UPLOAD_BYTES;
  const seen = new Set<string>();
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"item_completed"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const event = row?.payload;
      const item = event?.item;
      if (row?.type !== "event_msg" || event?.type !== "item_completed" || event.thread_id !== threadId
        || typeof event.turn_id !== "string" || !isRecord(item)) continue;
      if (item.type === "UserMessage" && Array.isArray(item.content)
        && item.content.some(part => part?.type === "text" && part.text === prompt)) {
        turnId = event.turn_id;
      }
      if (event.turn_id !== turnId || item.type !== "Extension" || item.kind !== "image_gen.generation") continue;
      if (item.status === "failed") { failed = true; continue; }
      if (item.status !== "completed" || typeof item.id !== "string" || seen.has(item.id)) continue;
      seen.add(item.id);
      try {
        const bytes = await imageBytes(item, home, threadId, budget);
        if (!bytes?.length || bytes.length > budget) throw new Error();
        const { type, width, height } = imageSize(bytes);
        if (!["png", "jpg", "webp"].includes(type ?? "") || !width || !height) throw new Error();
        budget -= bytes.length;
        const photo = type !== "webp" && bytes.length <= 10 * 1024 * 1024
          && width + height <= 10_000 && Math.max(width, height) <= 20 * Math.min(width, height);
        result.images.push({ bytes, filename: `codex-${result.images.length + 1}.${type}`, photo });
      } catch {
        result.notice = "部分生成图片无法读取或超出回传大小限制。";
      }
    }
  } finally {
    stream.destroy();
  }
  if (!turnId) result.notice = "无法匹配本次 Codex 回合，未回传图片。";
  else if (failed && !result.images.length && !result.notice) result.notice = "Codex 内置生图工具未生成图片。";
  return result;
}
