// src/services/AIService.ts
import { createNamedLogger } from '@/logging';

const moduleLog = createNamedLogger('AIService');

export interface AIChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIChatConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

export async function sendChatMessage(
  messages: AIChatMessage[],
  config: AIChatConfig,
  onChunk?: (text: string) => void,
): Promise<string> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: onChunk != null,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    moduleLog.error('API error', response.status, body);
    throw new Error(`API error ${response.status}: ${body}`);
  }

  if (onChunk) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let full = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            onChunk(delta);
          }
        } catch { continue; }
      }
    }
    return full;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}
