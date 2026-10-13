import { NextRequest, NextResponse } from "next/server";
import { fetchPostizPostStatus } from "@/lib/postiz";
import { currentUser, unauthorized } from "@/lib/auth";

/**
 * GET /api/social/post-status?postIds=id1,id2,id3
 * 
 * Fetches the current state of one or more Postiz posts.
 * Returns { statuses: { [postId]: "DRAFT" | "PUBLISHED" | "SCHEDULED" | "ERROR" | null } }
 */
export async function GET(req: NextRequest) {
  const auth = await currentUser();
  if (!auth) return unauthorized();

  const { searchParams } = new URL(req.url);
  const postIdsParam = searchParams.get("postIds");
  
  if (!postIdsParam) {
    return NextResponse.json({ error: "postIds parameter is required" }, { status: 400 });
  }

  const postIds = postIdsParam.split(",").map(id => id.trim()).filter(Boolean);
  
  if (postIds.length === 0) {
    return NextResponse.json({ statuses: {} });
  }

  try {
    const statusMap = await fetchPostizPostStatus(postIds);
    const statuses: Record<string, string | null> = {};
    statusMap.forEach((state, postId) => {
      statuses[postId] = state;
    });

    return NextResponse.json({ statuses });
  } catch (error) {
    console.error("[api/social/post-status] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch post status from Postiz" },
      { status: 500 }
    );
  }
}
