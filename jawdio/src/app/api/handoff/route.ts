import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';

import { getDataRoot, getTempHandoffPath } from '@/lib/storage';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const bytes = await file.arrayBuffer();
    
    await mkdir(getDataRoot(), { recursive: true });
    const tempPath = getTempHandoffPath();
    await writeFile(tempPath, Buffer.from(bytes));
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Handoff failed" }, { status: 500 });
  }
}
