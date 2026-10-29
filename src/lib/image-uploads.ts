import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { database } from "@/lib/project-db";
import { areImageMediaIds, isImageMediaId, type ImageAttachment } from "./image-types";

export interface StoredImageUpload extends ImageAttachment {
  ownerUserId: string;
  requestId: string;
  checksum: string;
  postizMediaId: string;
  postizPath: string;
  thumbnailDataUrl: string;
}

type ImageConnection = Pick<PoolConnection, "execute">;
const columns = `id, owner_user_id AS ownerUserId, request_id AS requestId, checksum,
  postiz_media_id AS postizMediaId, postiz_path AS postizPath, filename AS name,
  byte_size AS bytes, width, height, thumbnail_data AS thumbnailDataUrl`;

function fromRow(row: RowDataPacket): StoredImageUpload {
  const image: StoredImageUpload = {
    id: String(row.id), ownerUserId: String(row.ownerUserId), requestId: String(row.requestId),
    checksum: String(row.checksum), postizMediaId: String(row.postizMediaId), postizPath: String(row.postizPath),
    name: String(row.name), bytes: Number(row.bytes), width: Number(row.width), height: Number(row.height),
    thumbnailDataUrl: String(row.thumbnailDataUrl)
  };
  if (!isImageMediaId(image.id) || !image.postizMediaId || !image.postizPath
    || ![image.bytes, image.width, image.height].every(value => Number.isSafeInteger(value) && value > 0)
    || !image.thumbnailDataUrl.startsWith("data:image/")) throw new Error("Invalid stored image upload.");
  return image;
}

export function imageAttachment(image: StoredImageUpload): ImageAttachment {
  return { id: image.id, name: image.name, bytes: image.bytes, width: image.width, height: image.height };
}

export async function getImageUploads(ownerUserId: string, ids: readonly string[], connection?: ImageConnection): Promise<StoredImageUpload[]> {
  if (!ownerUserId || !areImageMediaIds(ids)) throw new Error("Invalid image attachments.");
  if (!ids.length) return [];
  const normalized = ids.map(id => id.toLowerCase());
  const [rows] = await (connection ?? database()).execute<RowDataPacket[]>(
    `SELECT ${columns} FROM image_uploads WHERE owner_user_id=? AND id IN (${normalized.map(() => "?").join(",")})`,
    [ownerUserId, ...normalized]
  );
  const images = new Map(rows.map(row => { const image = fromRow(row); return [image.id, image]; }));
  if (images.size !== normalized.length) throw new Error("An image attachment is unavailable in this account.");
  return normalized.map(id => images.get(id)!);
}

export async function findImageRequest(ownerUserId: string, requestId: string): Promise<StoredImageUpload | null> {
  const [rows] = await database().execute<RowDataPacket[]>(
    `SELECT ${columns} FROM image_uploads WHERE owner_user_id=? AND request_id=?`, [ownerUserId, requestId]
  );
  return rows.length ? fromRow(rows[0]) : null;
}

export async function recordImageUpload(input: Omit<StoredImageUpload, "id">): Promise<StoredImageUpload> {
  const image = { ...input, id: randomUUID() };
  try {
    await database().execute(
      `INSERT INTO image_uploads
        (id, owner_user_id, request_id, checksum, postiz_media_id, postiz_path, filename, byte_size, width, height, thumbnail_data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [image.id, image.ownerUserId, image.requestId, image.checksum, image.postizMediaId, image.postizPath,
        image.name, image.bytes, image.width, image.height, image.thumbnailDataUrl]
    );
    return image;
  } catch (error) {
    if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    const existing = await findImageRequest(input.ownerUserId, input.requestId);
    if (!existing || existing.checksum !== input.checksum) throw new Error("The image upload request has changed.");
    return existing;
  }
}
