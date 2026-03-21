import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const clipsPath = path.join(process.cwd(), 'public/clips');

export async function GET() {
  if (!fs.existsSync(clipsPath)) fs.mkdirSync(clipsPath, { recursive: true });
  const files = fs.readdirSync(clipsPath);
  const clips = [];

  for (const file of files) {
    if (file.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(path.join(clipsPath, file), 'utf8'));
      clips.push(data);
    }
  }
  return NextResponse.json({ clips });
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const name = formData.get('name') as string;
    const start = formData.get('start') as string;
    const end = formData.get('end') as string;

    if (!fs.existsSync(clipsPath)) fs.mkdirSync(clipsPath, { recursive: true });

    const id = Date.now().toString();
    const audioFileName = `clip_${id}.webm`;
    const jsonFileName = `clip_${id}.json`;

    // Save Audio Blob
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(clipsPath, audioFileName), buffer);

    // Save Non-Destructive Trim Metadata
    const metadata = {
      id,
      name: name || 'Untitled Clip',
      filename: `/clips/${audioFileName}`,
      start: parseFloat(start),
      end: parseFloat(end)
    };
    fs.writeFileSync(path.join(clipsPath, jsonFileName), JSON.stringify(metadata, null, 2));

    return NextResponse.json({ success: true, metadata });
  } catch (error) {
    console.error("Failed to save clip:", error);
    return NextResponse.json({ error: "Failed to save clip" }, { status: 500 });
  }
}
