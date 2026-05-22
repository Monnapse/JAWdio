import { NextResponse } from 'next/server';

type AutoClipperAiMode = 'title' | 'semantic';

interface AutoClipperAiRequest {
  mode?: AutoClipperAiMode;
  transcript?: string;
  openAiKey?: string;
  clipDurationSeconds?: number;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface SemanticResult {
  clipWorthy?: boolean;
  startOffsetSec?: number;
  endOffsetSec?: number;
  reason?: string;
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

const getConfiguredOpenAiKey = () =>
  process.env.OPENAI_API_KEY?.trim() ||
  process.env.OPEN_AI_API_KEY?.trim() ||
  process.env.NEXT_PUBLIC_OPENAI_API_KEY?.trim() ||
  '';

const resolveOpenAiKey = (providedKey?: string) =>
  providedKey?.trim() || getConfiguredOpenAiKey();

const compactTitle = (value: string) => {
  const words = value
    .trim()
    .replace(/^title:\s*/i, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);

  return words.join(' ').slice(0, 48) || 'Clip';
};

const stripTitle = (value: string) =>
  compactTitle(
    value
      .replace(/^["']+/, '')
      .replace(/["'.]+$/g, ''),
  );

const parseJsonObject = (value: string): SemanticResult => {
  const trimmed = value.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  return JSON.parse(jsonText) as SemanticResult;
};

const callOpenAi = async (
  apiKey: string,
  body: Record<string, unknown>,
): Promise<string> => {
  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await response.json().catch(() => null)) as OpenAiChatResponse | null;

  if (!response.ok) {
    throw new Error(json?.error?.message ?? `OpenAI request failed (${response.status}).`);
  }

  const content = json?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('OpenAI returned an empty response.');
  }

  return content;
};

export function GET() {
  return NextResponse.json({ configured: getConfiguredOpenAiKey().length > 0 });
}

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as AutoClipperAiRequest;
    const mode = payload.mode;
    const transcript = payload.transcript?.trim() ?? '';
    const apiKey = resolveOpenAiKey(payload.openAiKey);

    if (!apiKey) {
      return NextResponse.json(
        { error: 'OpenAI API key is not configured.' },
        { status: 400 },
      );
    }

    if (!transcript) {
      return NextResponse.json({ error: 'Transcript is required.' }, { status: 400 });
    }

    if (mode === 'title') {
      const content = await callOpenAi(apiKey, {
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You generate punchy 2-3 word button titles for soundboard clips. ' +
              'Use the quote itself, avoid generic labels like Funny Moment, ' +
              'and reply with the title only: 2-3 words, no quotes, no punctuation.',
          },
          {
            role: 'user',
            content: `Transcript:\n${transcript}\n\nReturn only the title:`,
          },
        ],
        max_tokens: 16,
        temperature: 0.7,
      });

      return NextResponse.json({ title: stripTitle(content) });
    }

    if (mode === 'semantic') {
      const content = await callOpenAi(apiKey, {
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are scanning the last 20 seconds of a livestream voice chat for ' +
              'clip-worthy moments: funny lines, sudden punchlines, memorable ' +
              'out-of-context quotes. Reply only with strict JSON: ' +
              '{"clipWorthy":boolean,"startOffsetSec":number,"endOffsetSec":number,"reason":string}. ' +
              'startOffsetSec and endOffsetSec are seconds before the end of the ' +
              'transcript, so 0 means the latest word. Keep reason short.',
          },
          {
            role: 'user',
            content: `Transcript:\n${transcript}`,
          },
        ],
        max_tokens: 80,
        temperature: 0.4,
        response_format: { type: 'json_object' },
      });
      const parsed = parseJsonObject(content);

      return NextResponse.json({
        clipWorthy: Boolean(parsed.clipWorthy),
        startOffsetSec:
          typeof parsed.startOffsetSec === 'number'
            ? parsed.startOffsetSec
            : payload.clipDurationSeconds,
        endOffsetSec:
          typeof parsed.endOffsetSec === 'number' ? parsed.endOffsetSec : 0,
      });
    }

    return NextResponse.json({ error: 'Unsupported AI mode.' }, { status: 400 });
  } catch (error) {
    console.error('AutoClipper AI request failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI request failed.' },
      { status: 500 },
    );
  }
}
