import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

import { type MediaKind, resolveMediaPath } from "@/lib/storage";

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

const isMediaKind = (value: string): value is MediaKind =>
  value === "clips" || value === "sounds";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filePath: string[]; kind: string }> },
) {
  const { kind, filePath } = await params;

  if (!isMediaKind(kind)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const resolvedPath = resolveMediaPath(kind, filePath);

  if (!resolvedPath) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const stats = await fs.stat(resolvedPath.absolutePath);

    if (!stats.isFile()) {
      return new NextResponse("Not found", { status: 404 });
    }

    const fileBuffer = await fs.readFile(resolvedPath.absolutePath);
    const extension = path.extname(resolvedPath.absolutePath).toLowerCase();

    return new NextResponse(fileBuffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Length": String(stats.size),
        "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
