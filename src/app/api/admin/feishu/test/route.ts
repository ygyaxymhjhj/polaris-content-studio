import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { isSameOrigin } from "@/lib/same-origin";
import { asFeishuError, FeishuError, readFeishuRequestBody, testFeishuSettings } from "@/lib/feishu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "30" } : {}) } });
const testSchema = z.object({}).strict();

export async function POST(request: NextRequest) {
  try {
    const auth = await currentUser();
    if (!auth) return json({ error: "Sign in to continue.", code: "UNAUTHORIZED" }, 401);
    if (auth.user.role !== "admin") return json({ error: "Only administrators can test Feishu settings.", code: "FORBIDDEN" }, 403);
    if (!isSameOrigin(request)) return json({ error: "Same-origin request required.", code: "FORBIDDEN" }, 403);
    if (!testSchema.safeParse(await readFeishuRequestBody(request)).success) throw new FeishuError("The test accepts an empty JSON object and uses saved credentials only.", "FEISHU_INVALID_INPUT", 400);
    await testFeishuSettings(auth.user.displayName || "Admin");
    return json({ success: true });
  } catch (error) {
    const sanitized = asFeishuError(error);
    return json({ error: sanitized.message, code: sanitized.code, retryable: sanitized.retryable }, sanitized.status);
  }
}
