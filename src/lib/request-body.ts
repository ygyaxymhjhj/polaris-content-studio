/**
 * Reads a JSON request body with a hard byte limit. Manual posts carry an inline image data URL,
 * so the limit has to be larger than a plain text payload but still bounded before parsing.
 */
export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "empty" | "too_large" | "invalid" };

export async function readBoundedJson(request: Request, limitBytes: number): Promise<BoundedJsonResult> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "empty" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!size) return { ok: false, reason: "empty" };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
