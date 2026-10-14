import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isSameOrigin } from "@/lib/same-origin";
import { asFeishuError, FeishuError, feishuUpdateSchema, readFeishuRequestBody, readFeishuSettings, updateFeishuSettings } from "@/lib/feishu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => {
  const sanitized = asFeishuError(error);
  return json({ error: sanitized.message, code: sanitized.code, retryable: sanitized.retryable }, sanitized.status);
};

export async function GET() {
  try {
    const auth = await currentUser();
    if (!auth) return json({ error: "Sign in to continue.", code: "UNAUTHORIZED" }, 401);
    if (auth.user.role !== "admin") return json({ error: "Only administrators can manage Feishu settings.", code: "FORBIDDEN" }, 403);
    return json(await readFeishuSettings());
  } catch (error) { return failure(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await currentUser();
    if (!auth) return json({ error: "Sign in to continue.", code: "UNAUTHORIZED" }, 401);
    if (auth.user.role !== "admin") return json({ error: "Only administrators can manage Feishu settings.", code: "FORBIDDEN" }, 403);
    if (!isSameOrigin(request)) return json({ error: "Same-origin request required.", code: "FORBIDDEN" }, 403);
    const parsed = feishuUpdateSchema.safeParse(await readFeishuRequestBody(request));
    if (!parsed.success) throw new FeishuError("Invalid Feishu settings.", "FEISHU_INVALID_INPUT", 400);
    return json(await updateFeishuSettings(parsed.data, auth.user.id));
  } catch (error) { return failure(error); }
}
