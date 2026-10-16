import sharp from "sharp";
import { POST_TITLE_MAX_LENGTH } from "./post-types";

/**
 * Server-side validation for manual post images.
 *
 * The browser already compresses uploads, but the API can be called directly, so the stored image
 * is re-validated here: it must be an inline data URL of a single-frame JPEG/PNG/WebP, it must
 * actually decode, its pixel count and dimensions are bounded, and it is re-encoded into a
 * thumbnail. Remote URLs are rejected outright - a URL would make the server fetch attacker-chosen
 * addresses at submission time.
 */

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);
const ACCEPTED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp"
};

/** Binary size accepted for the stored image. The browser targets 1 MiB; this leaves margin. */
export const MAX_POST_IMAGE_BYTES = 1_500_000;
/** Base64 encoding of MAX_POST_IMAGE_BYTES, plus the data URL prefix. */
export const MAX_POST_IMAGE_DATA_URL_LENGTH = 4 * Math.ceil(MAX_POST_IMAGE_BYTES / 3) + 64;
/** Decompression-bomb guard: the browser caps the longest edge at 2048px, so 4.2M pixels is the ceiling. */
const MAX_INPUT_PIXELS = 4_200_000;
const MAX_IMAGE_DIMENSION = 2048;
const THUMBNAIL_DIMENSION = 480;

const dataUrlPattern = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export interface ValidatedPostImage {
  /** Normalized data URL in the original format, re-encoded so EXIF metadata does not travel on. */
  dataUrl: string;
  /** Small JPEG data URL for list rendering. */
  thumbnailDataUrl: string;
  width: number;
  height: number;
  filename: string;
}

export type PostImageValidation = { ok: true; image: ValidatedPostImage } | { ok: false; error: string };

function decodeDataUrl(dataUrl: string): { buffer: Buffer; format: string } | null {
  const match = dataUrlPattern.exec(dataUrl);
  if (!match) return null;
  const format = ACCEPTED_MIME_TYPES[match[1] === "jpg" ? "image/jpeg" : `image/${match[1]}`];
  if (!format) return null;
  // Reject on the encoded length before allocating the decoded buffer.
  if (dataUrl.length > MAX_POST_IMAGE_DATA_URL_LENGTH) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_POST_IMAGE_BYTES) return null;
  return { buffer, format };
}

function encodeDataUrl(format: string, buffer: Buffer): string {
  const mimeType = format === "jpeg" ? "image/jpeg" : `image/${format}`;
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/**
 * Validates and normalizes an uploaded image. Returns a message suitable for the API response on
 * rejection; the message deliberately does not echo any part of the input.
 */
export async function validatePostImage(dataUrl: string, filename?: string): Promise<PostImageValidation> {
  if (!dataUrl.startsWith("data:image/")) {
    return { ok: false, error: "The post image must be an uploaded JPG, PNG or WebP file." };
  }
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) {
    return { ok: false, error: "Use a JPG, PNG or WebP image of up to 1.5 MB." };
  }

  try {
    const input = sharp(decoded.buffer, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    const metadata = await input.metadata();
    if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
      return { ok: false, error: "Use a JPG, PNG or WebP image." };
    }
    if ((metadata.pages ?? 1) > 1) {
      return { ok: false, error: "Animated images are not supported. Use a still JPG, PNG or WebP image." };
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) return { ok: false, error: "The image dimensions could not be read. Try another file." };
    // EXIF rotation can swap the edges, but never enlarges the longest one.
    if (Math.max(width, height) > MAX_IMAGE_DIMENSION) {
      return { ok: false, error: "Images larger than 2048 px on the longest edge are not accepted. Resize the file and try again." };
    }

    // A small probe forces a real pixel decode of the whole file, so truncated or corrupted data
    // fails here instead of surfacing as a broken image inside Postiz.
    const normalized = await sharp(decoded.buffer, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .toFormat(decoded.format as "jpeg" | "png" | "webp")
      .toBuffer();
    if (!normalized.length || normalized.length > MAX_POST_IMAGE_BYTES) {
      return { ok: false, error: "The image is too large after processing. Try a smaller file." };
    }

    const thumbnail = await sharp(decoded.buffer, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize({ width: THUMBNAIL_DIMENSION, height: THUMBNAIL_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();

    return {
      ok: true,
      image: {
        dataUrl: encodeDataUrl(decoded.format, normalized),
        thumbnailDataUrl: encodeDataUrl("jpeg", thumbnail),
        width,
        height,
        filename: (filename || "post-image").slice(0, POST_TITLE_MAX_LENGTH)
      }
    };
  } catch {
    return { ok: false, error: "Could not read this image. Use a valid JPG, PNG or WebP file." };
  }
}

/** Decodes a stored data URL for the authenticated image endpoint. */
export function postImageBuffer(dataUrl: string | null): { buffer: Buffer; contentType: string } | null {
  if (!dataUrl) return null;
  const match = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  try {
    return { buffer: Buffer.from(match[2], "base64"), contentType: match[1] };
  } catch {
    return null;
  }
}
