import mammoth from "mammoth";
import { NextResponse } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";

export async function POST(request: Request) {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No DOCX file provided" }, { status: 400 });
    }
    if (file.name.toLowerCase().endsWith(".json")) {
      const data = JSON.parse(await file.text()) as { text?: string; title?: string; sourceUrl?: string; canonical?: string; imageUrl?: string };
      if (!data.text?.trim()) return NextResponse.json({ error: "Crawler JSON does not contain article text" }, { status: 400 });
      return NextResponse.json({ text: data.text, title: data.title, sourceUrl: data.sourceUrl, canonical: data.canonical, imageUrl: data.imageUrl, messages: [] });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return NextResponse.json({ text: result.value, messages: result.messages });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not parse document" }, { status: 500 });
  }
}
