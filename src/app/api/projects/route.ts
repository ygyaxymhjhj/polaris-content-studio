import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { database, databaseConfigured } from "@/lib/project-db";
import { projectSchema, saveProjectSchema, type ProjectSnapshot } from "@/lib/project-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cookieName = "polaris-project-owner";
function owner(request: NextRequest) { const token = request.cookies.get(cookieName)?.value; return token && /^[a-f0-9]{64}$/.test(token) ? token : null; }
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
function sameOrigin(request: NextRequest) { return request.headers.get("origin") === new URL(request.url).origin; }
function failure(error: unknown) {
  const code = (error as { code?: string })?.code;
  console.error("[projects] request failed", code || "INVALID_DATA_OR_STORAGE");
  if (code === "ER_DUP_ENTRY") return json({ error: "Project changed in another tab. Reload it from history before saving.", code: "CONFLICT" }, 409);
  return json({ error: "Database unavailable. Keep this page open and retry saving.", code: "STORAGE_UNAVAILABLE" }, 503);
}
export async function GET(request: NextRequest) {
  if (!databaseConfigured()) return json({ enabled: false, projects: [] });
  try {
    const token = owner(request) || randomBytes(32).toString("hex");
    const id = request.nextUrl.searchParams.get("id");
    let response: NextResponse;
    if (id) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) return json({ error: "Invalid project ID" }, 400);
      const [rows] = await database().execute<RowDataPacket[]>("SELECT id, version, snapshot FROM projects WHERE id=? AND owner_hash=?", [id, hash(token)]);
      if (!rows.length) return json({ error: "Project not found in this browser's history." }, 404);
      const snapshot = projectSchema.parse(typeof rows[0].snapshot === "string" ? JSON.parse(rows[0].snapshot) : rows[0].snapshot);
      response = json({ id, version: rows[0].version, snapshot });
    } else {
      const [rows] = await database().execute<RowDataPacket[]>("SELECT id, name, version, updated_at AS updatedAt, JSON_LENGTH(snapshot, '$.assets') AS assetCount FROM projects WHERE owner_hash=? ORDER BY updated_at DESC LIMIT 100", [hash(token)]);
      response = json({ enabled: true, projects: rows });
    }
    response.cookies.set(cookieName, token, { httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 365 });
    return response;
  } catch (error) { return failure(error); }
}

async function boundedJson(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("EMPTY");
  const buffers: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("TOO_LARGE"); }
    buffers.push(value);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}
export async function PUT(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const token = owner(request);
  if (!token) return json({ error: "Open project history to initialize this browser's storage session." }, 401);
  let parsed;
  try { parsed = saveProjectSchema.safeParse(await boundedJson(request)); }
  catch (error) {
    const tooLarge = error instanceof Error && error.message === "TOO_LARGE";
    return json({ error: tooLarge ? "Project exceeds the 4 MB storage limit." : "Invalid project data." }, tooLarge ? 413 : 400);
  }
  if (!parsed.success) return json({ error: "Invalid project data. No changes were saved." }, 400);
  const { id, version, snapshot } = parsed.data;
  try {
    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT version, snapshot FROM projects WHERE id=? AND owner_hash=? FOR UPDATE", [id, hash(token)]);
      if ((rows.length && rows[0].version !== version) || (!rows.length && version !== 0)) {
        await connection.rollback(); return json({ error: "Project changed in another tab. Reload it from history before saving.", code: "CONFLICT" }, 409);
      }
      if (rows.length) {
        const previous: ProjectSnapshot = typeof rows[0].snapshot === "string" ? JSON.parse(rows[0].snapshot) : rows[0].snapshot;
        // Preserve completed/partial results before a source replacement or a new generation run.
        if (previous.assets.length && (previous.sourceText !== snapshot.sourceText || previous.generationRun !== snapshot.generationRun)) {
          await connection.execute("INSERT INTO projects (id, owner_hash, name, snapshot) VALUES (?,?,?,?)", [randomUUID(), hash(token), `${previous.config.name || previous.config.title} · archive`.slice(0, 255), JSON.stringify(previous)]);
        }
        await connection.execute("UPDATE projects SET name=?, snapshot=?, version=version+1, updated_at=CURRENT_TIMESTAMP(3) WHERE id=? AND owner_hash=?", [(snapshot.config.name || snapshot.config.title || "Untitled").slice(0, 255), JSON.stringify(snapshot), id, hash(token)]);
      } else {
        await connection.execute("INSERT INTO projects (id, owner_hash, name, snapshot) VALUES (?,?,?,?)", [id, hash(token), (snapshot.config.name || snapshot.config.title || "Untitled").slice(0, 255), JSON.stringify(snapshot)]);
      }
      await connection.commit();
      return json({ id, version: version + 1 });
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  } catch (error) { return failure(error); }
}
