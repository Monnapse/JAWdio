import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const soundsPath = path.join(process.cwd(), 'public/sounds');

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const category = formData.get('category') as string;

    if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Determine folder: Root if uncategorized, otherwise the folder name
    const targetDir = (category && category !== "Uncategorized") 
      ? path.join(soundsPath, category) 
      : soundsPath;

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const filePath = path.join(targetDir, file.name);
    fs.writeFileSync(filePath, buffer);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}