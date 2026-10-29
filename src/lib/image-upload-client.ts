import { createClientId } from "./client-id";
import { prepareUploadedImage, type PreparedImage } from "./image-upload";
import { isImageMediaId, type ImageAttachment } from "./image-types";

const pendingFiles = new WeakMap<File, { requestId: string; prepared?: PreparedImage }>();
const legacyFiles = new Map<string, File>();
const legacyRequests = new Map<string, string>();

async function sendImage(body: object, signal: AbortSignal): Promise<ImageAttachment> {
  const response = await fetch("/api/media/images", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "Could not upload this image. Please try again.");
  const image = result?.image;
  if (!image || !isImageMediaId(image.id) || typeof image.name !== "string"
    || ![image.bytes, image.width, image.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("The image upload returned an invalid response. Please try again.");
  }
  return { id: image.id, name: image.name, bytes: image.bytes, width: image.width, height: image.height };
}

export async function uploadImage(file: File, signal: AbortSignal): Promise<ImageAttachment> {
  let pending = pendingFiles.get(file);
  if (!pending) { pending = { requestId: createClientId() }; pendingFiles.set(file, pending); }
  pending.prepared ??= await prepareUploadedImage(file);
  signal.throwIfAborted();
  return sendImage({ requestId: pending.requestId, dataUrl: pending.prepared.dataUrl, name: pending.prepared.name }, signal);
}

export async function importLegacyImage(imageUrl: string, signal: AbortSignal): Promise<ImageAttachment> {
  const url = new URL(imageUrl, window.location.origin);
  if (url.protocol !== "data:" && url.origin !== window.location.origin) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("The original image URL is invalid.");
    let requestId = legacyRequests.get(imageUrl);
    if (!requestId) { requestId = createClientId(); legacyRequests.set(imageUrl, requestId); }
    return sendImage({ requestId, sourceUrl: url.href, name: "original-image" }, signal);
  }
  if (url.protocol !== "data:" && !/^\/api\/posts\/[a-f0-9-]{36}\/image$/.test(url.pathname)) {
    throw new Error("The original image URL is invalid.");
  }
  let file = legacyFiles.get(imageUrl);
  if (!file) {
    const response = await fetch(url.href, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("Could not read the original image. Please try again.");
    const blob = await response.blob();
    file = new File([blob], "original-image", { type: blob.type });
    // ponytail: cache only the latest legacy conversion; a media library can own broader reuse later.
    legacyFiles.clear();
    legacyFiles.set(imageUrl, file);
  }
  return uploadImage(file, signal);
}
