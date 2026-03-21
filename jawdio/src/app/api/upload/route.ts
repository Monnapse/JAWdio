import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import {
  ensureSoundsPath,
  ensureUniqueFilePath,
  getCategoryDirectory,
  listSoundLibrary,
  normalizeUploadFilename,
} from "@/lib/sound-library";

export async function POST(req: Request) {
  try {
    ensureSoundsPath();

    const formData = await req.formData();
    const file = formData.get("file");
    const category = String(formData.get("category") ?? "Uncategorized");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const normalizedFilename = normalizeUploadFilename(file.name);

    if (!normalizedFilename) {
      return NextResponse.json(
        { error: "Only .mp3, .wav, .m4a, and .ogg files are supported." },
        { status: 400 },
      );
    }

    const targetDirectory = getCategoryDirectory(category);
    fs.mkdirSync(targetDirectory, { recursive: true });

    const filePath = ensureUniqueFilePath(path.join(targetDirectory, normalizedFilename));
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    return NextResponse.json({ success: true, library: listSoundLibrary() });
  } catch (error) {
    console.error("Upload failed:", error);
    return NextResponse.json({ error: "Upload failed." }, { status: 500 });
  }
}
