import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // 1. Put your free Groq API key here (or in a .env.local file)
    const groqApiKey = "gsk_YOUR_FREE_API_KEY_HERE";

    const groqFormData = new FormData();
    groqFormData.append('file', file);
    groqFormData.append('model', 'whisper-large-v3-turbo'); // Groq's blazing fast model

    // 2. Send the audio to Groq's free tier servers
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqApiKey}` },
      body: groqFormData,
    });

    const data = await response.json();
    
    if (data.text) {
      return NextResponse.json({ text: data.text });
    } else {
      return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
    }

  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
  }
}