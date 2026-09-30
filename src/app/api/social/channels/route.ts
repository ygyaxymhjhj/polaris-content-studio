import { NextResponse } from "next/server";
import { fetchPostizIntegrations } from "@/lib/postiz";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await fetchPostizIntegrations();
  return NextResponse.json(result);
}
