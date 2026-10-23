import { normalizeImageSize, validateImageModelSize } from "./image-generation-plan.js";

export async function parseImageApiRequest(body: Buffer, contentType: string, editing: boolean): Promise<string> {
  let fields: Record<string, unknown>;
  if (editing) {
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new Error("Image edits require multipart/form-data.");
    const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
    for (const name of ["model", "prompt", "n", "size", "response_format"]) {
      if (form.getAll(name).length > 1) throw new Error(`Duplicate image field: ${name}.`);
    }
    const images = [...form.getAll("image"), ...form.getAll("image[]")];
    if (!images.length || images.length > 8) throw new Error("Upload 1–8 reference images.");
    const masks = form.getAll("mask");
    if (masks.length > 1) throw new Error("Upload at most one mask.");
    let totalBytes = 0;
    for (const image of [...images, ...masks]) {
      if (typeof image === "string" || !image.size || image.size > 20 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(image.type)) {
        throw new Error("Images must be uploaded PNG, JPEG or WebP files, at most 20 MiB each.");
      }
      totalBytes += image.size;
    }
    if (totalBytes > 40 * 1024 * 1024) throw new Error("Uploaded images must not exceed 40 MiB in total.");
    fields = Object.fromEntries(["model", "prompt", "n", "size", "response_format"].map(name => [name, form.get(name) ?? undefined]));
    if (typeof fields.n === "string") fields.n = Number(fields.n);
  } else {
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error("Image generation requires application/json.");
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
    fields = value as Record<string, unknown>;
  }
  if (typeof fields.model !== "string" || !fields.model.trim()) throw new Error("Image model is required.");
  if (typeof fields.prompt !== "string" || !fields.prompt.trim() || fields.prompt.length > 200_000) throw new Error("Image prompt is required (at most 200000 characters).");
  if (fields.n !== undefined && (!Number.isInteger(fields.n) || Number(fields.n) < 1 || Number(fields.n) > 8)) throw new Error("Image n must be an integer from 1 to 8.");
  if (fields.size !== undefined) {
    if (typeof fields.size !== "string") throw new Error("Image size must be a string.");
    normalizeImageSize(fields.size);
    validateImageModelSize(fields.model, fields.size);
  }
  if (fields.response_format !== undefined && !["url", "b64_json"].includes(String(fields.response_format))) throw new Error("response_format must be url or b64_json.");
  return fields.model.trim();
}
