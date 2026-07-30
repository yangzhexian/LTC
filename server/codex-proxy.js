#!/usr/bin/env node
/**
 * Codex CLI Proxy — bridges TeXlyre AI Assistant to a local codex CLI.
 *
 * Implements the OpenAI /v1/chat/completions API so TeXlyre's AI service
 * can talk to it without modification.  Under the hood it:
 *   1. Reads the Anthropic API key from ~/.anthropic/config (used by codex)
 *   2. Translates OpenAI-format messages → Anthropic Messages API
 *   3. Streams the response back in OpenAI SSE format
 *
 * Usage:  node server/codex-proxy.js [port]
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = parseInt(process.argv[2] || '8083', 10);

// ---- Discover API key from codex / Anthropic config ----
function findApiKey() {
  const paths = [
    join(homedir(), '.anthropic', 'config'),
    join(homedir(), '.codex', 'config'),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, 'utf-8');
      const match = content.match(/api_key\s*[=:]\s*(sk-ant-[\w-]+)/);
      if (match) return match[1];
    } catch { continue; }
  }

  // Also check environment variable
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (process.env.CODEX_API_KEY) return process.env.CODEX_API_KEY;

  return null;
}

const API_KEY = findApiKey();
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL_MAP = {
  'gpt-4o': 'claude-sonnet-4-20250514',
  'gpt-4o-mini': 'claude-sonnet-4-20250514',
  'gpt-4': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  'claude-3-haiku': 'claude-3-haiku-20240307',
};
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

if (!API_KEY) {
  console.error('WARNING: No Anthropic API key found.');
  console.error('  Set ANTHROPIC_API_KEY env var, or configure ~/.anthropic/config');
  console.error('  The server will start but AI calls will fail until a key is set.\n');
}

// ---- Helper: translate OpenAI messages → Anthropic messages ----
function toAnthropicMessages(openaiMessages) {
  const system = [];
  const messages = [];

  for (const m of openaiMessages) {
    if (m.role === 'system') {
      system.push(m.content);
    } else if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.content });
    }
  }

  return {
    system: system.length > 0 ? system.join('\n') : undefined,
    messages,
  };
}

// ---- SSE helpers ----
function sseMessage(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404);
    res.end('Only POST /v1/chat/completions is served\n');
    return;
  }

  if (!API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Anthropic API key not configured' }));
    return;
  }

  // Read body
  const body = await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

  let openaiReq;
  try {
    openaiReq = JSON.parse(body);
  } catch (e) {
    res.writeHead(400);
    res.end('Invalid JSON\n');
    return;
  }

  const isStream = openaiReq.stream === true;
  const { system, messages } = toAnthropicMessages(openaiReq.messages || []);
  const model = MODEL_MAP[openaiReq.model] || DEFAULT_MODEL;
  const maxTokens = openaiReq.max_tokens || 4096;

  const anthropicBody = {
    model,
    max_tokens: maxTokens,
    stream: isStream,
    messages,
  };
  if (system) anthropicBody.system = system;

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Anthropic API error ${response.status}: ${err.slice(0, 500)}` }));
      return;
    }

    if (!isStream) {
      const data = await response.json();
      const reply = {
        id: data.id,
        object: 'chat.completion',
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: data.content?.[0]?.text || '',
          },
          finish_reason: 'stop',
        }],
        usage: data.usage,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
      return;
    }

    // Streaming: translate Anthropic SSE → OpenAI SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const reader = response.body?.getReader();
    if (!reader) {
      sseDone(res);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let contentSoFar = '';
    let responseId = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const eventData = trimmed.slice(6);
        try {
          const parsed = JSON.parse(eventData);
          if (parsed.type === 'message_start') {
            responseId = parsed.message?.id || '';
            continue;
          }
          if (parsed.type === 'content_block_delta') {
            const text = parsed.delta?.text || '';
            if (text) {
              contentSoFar += text;
              sseMessage(res, {
                id: responseId,
                object: 'chat.completion.chunk',
                model,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                }],
              });
            }
          }
          if (parsed.type === 'message_delta') {
            const stopReason = parsed.delta?.stop_reason;
            if (stopReason) {
              sseMessage(res, {
                id: responseId,
                object: 'chat.completion.chunk',
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: stopReason === 'end_turn' ? 'stop' : stopReason,
                }],
              });
            }
          }
          if (parsed.type === 'message_stop') {
            sseDone(res);
          }
        } catch { continue; }
      }
    }

    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      sseDone(res);
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\nCodex Proxy (OpenAI-compatible API) running on http://localhost:${PORT}`);
  console.log(`  Endpoint:  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  Backend:   Anthropic API (${ANTHROPIC_API})`);
  if (API_KEY) console.log('  API key:   found ✓');
  else console.log('  API key:   MISSING ✗');
  console.log(`  Models:    ${Object.keys(MODEL_MAP).join(', ')}\n`);
});
