import { NextResponse } from "next/server";
import { publishToPostiz } from "@/lib/postiz";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      assetId?: string;
      integrationId?: string;
      content?: string;
      imageUrl?: string;
      publishAt?: string;
    };

    if (!body.integrationId) {
      return NextResponse.json({ error: "Target social channel integration ID is required" }, { status: 400 });
    }
    if (!body.content || !body.content.trim()) {
      return NextResponse.json({ error: "Post content cannot be empty" }, { status: 400 });
    }

    const result = await publishToPostiz({
      integrationId: body.integrationId,
      content: body.content.trim(),
      imageUrl: body.imageUrl?.trim() || undefined,
      publishAt: body.publishAt
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Failed to publish" }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      assetId: body.assetId,
      postId: result.postId,
      publishedUrl: result.url,
      publishedAt: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish request failed" },
      { status: 500 }
    );
  }
}
