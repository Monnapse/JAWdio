import { NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import path from 'path';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const bytes = await file.arrayBuffer();
    
    // Save to the public folder so the web client can fetch it immediately
    const tempPath = path.join(process.cwd(), 'public', 'temp_handoff.webm');
    await writeFile(tempPath, Buffer.from(bytes));
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Handoff failed" }, { status: 500 });
  }
}