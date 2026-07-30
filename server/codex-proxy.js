#!/usr/bin/env node
/**
 * AI Proxy — multi-backend bridge for TeXlyre AI Assistant.
 *
 * Implements OpenAI-compatible /v1/chat/completions (streaming).
 * Supports multiple backends:
 *
 *   backend=anthropic   — Uses ~/.anthropic/config API key (codex CLI compatible)
 *   backend=openai      — Uses OPENAI_API_KEY env var or settings
 *   backend=ollama      — Uses local Ollama (no API key needed, free)
 *   backend=chatgpt     — [EXPERIMENTAL] Uses ChatGPT Plus via browser session token
 *
 * Usage:  node server/codex-proxy.js [port] [backend]
 *         AI_PROXY_BACKEND=ollama node server/codex-proxy.js
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = parseInt(process.argv[2] || process.env.AI_PROXY_PORT || '8083', 10);
const BACKEND = process.argv[3] || process.env.AI_PROXY_BACKEND || 'anthropic';

// ============================================================
//  API key discovery
// ============================================================

function findAnthropicKey() {
  const paths = [
    join(homedir(), '.anthropic', 'config'),
    join(homedir(), '.codex', 'config'),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, 'utf-8');
      const m = content.match(/api_key\s*[=:]\s*(sk-ant-[\w-]+)/);
      if (m) return m[1];
    } catch { continue; }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

function findOpenAIKey() {
  return process.env.OPENAI_API_KEY || null;
}

// ============================================================
//  Backend implementations
// ============================================================

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const MODEL_ANTHROPIC = {
  'gpt-4o': 'claude-sonnet-4-20250514',
  'gpt-4o-mini': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  'claude-3-haiku': 'claude-3-haiku-20240307',
};

// ---- OpenAI message → Anthropic message ----
function toAnthropic(msgs) {
  const system = [];
  const messages = [];
  for (const m of msgs) {
    if (m.role === 'system') system.push(m.content);
    else if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content });
  }
  return { system: system.length ? system.join('\n') : undefined, messages };
}

// ---- Anthropic backend ----
async function* streamAnthropic(body, apiKey) {
  const { system, messages } = toAnthropic(body.messages || []);
  const model = MODEL_ANTHROPIC[body.model] || 'claude-sonnet-4-20250514';

  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: body.max_tokens || 4096, stream: true, system, messages }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text().catch(() => '')}`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      try {
        const p = JSON.parse(t.slice(6));
        if (p.type === 'content_block_delta' && p.delta?.text) yield p.delta.text;
      } catch { continue; }
    }
    buf = '';
  }
}

// ---- OpenAI backend ----
async function* streamOpenAI(body, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text().catch(() => '')}`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const d = t.slice(6);
      if (d === '[DONE]') continue;
      try {
        const p = JSON.parse(d);
        const delta = p.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { continue; }
    }
    buf = '';
  }
}

// ---- Ollama backend ----
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

async function* streamOllama(body) {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      messages: body.messages || [],
    }),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text().catch(() => '')}`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const p = JSON.parse(t);
        if (p.done) continue;
        if (p.message?.content) yield p.message.content;
      } catch { continue; }
    }
    buf = '';
  }
}

// ---- ChatGPT Bridge (EXPERIMENTAL) ----
// Uses the unofficial ChatGPT web API with a session token.
// The token can be obtained from chat.openai.com cookies
// (__Secure-next-auth.session-token).
const CHATGPT_TOKEN = process.env.CHATGPT_SESSION_TOKEN || '';

async function* streamChatGPT(body) {
  if (!CHATGPT_TOKEN) {
    throw new Error('CHATGPT_SESSION_TOKEN not set. Get it from chat.openai.com cookies.');
  }

  const resp = await fetch('https://chat.openai.com/backend-api/conversation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHATGPT_TOKEN}`,
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      action: 'next',
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: { content_type: 'text', parts: body.messages?.map(m => m.content) || [] },
        },
      ],
      model: body.model || 'gpt-4o',
      parent_message_id: crypto.randomUUID(),
    }),
  });
  if (!resp.ok) throw new Error(`ChatGPT ${resp.status}: ${await resp.text().catch(() => '')}`);

  // ChatGPT SSE format: data: {"message": {"content": {"parts": [...]}}}
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      try {
        const p = JSON.parse(t.slice(6));
        for (const part of p.message?.content?.parts || []) {
          if (typeof part === 'string') yield part;
        }
      } catch { continue; }
    }
    buf = '';
  }
}

// ============================================================
//  Server
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only POST /v1/chat/completions' }));
    return;
  }

  const body = JSON.parse(await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); }));

  let backend = body.backend || BACKEND;
  const isStream = body.stream !== false;
  let streamFn;

  try {
    switch (backend) {
      case 'anthropic': {
        const key = findAnthropicKey();
        if (!key) throw new Error('Anthropic API key not found. Configure ~/.anthropic/config or set ANTHROPIC_API_KEY');
        streamFn = streamAnthropic(body, key);
        break;
      }
      case 'openai': {
        const key = body.apiKey || findOpenAIKey();
        if (!key) throw new Error('OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey in request');
        streamFn = streamOpenAI(body, key);
        break;
      }
      case 'ollama': {
        streamFn = streamOllama(body);
        break;
      }
      case 'chatgpt': {
        streamFn = streamChatGPT(body);
        break;
      }
      default:
        throw new Error(`Unknown backend: ${backend} (choose: anthropic, openai, ollama, chatgpt)`);
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  // Streaming response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let content = '';
  for await (const chunk of streamFn) {
    content += chunk;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, () => {
  console.log(`\nAI Proxy running on http://localhost:${PORT}`);
  console.log(`  Endpoint: POST /v1/chat/completions`);
  console.log(`  Backend:  ${BACKEND}`);

  switch (BACKEND) {
    case 'anthropic':
      console.log(`  Key:      ${findAnthropicKey() ? '✓ found' : '✗ missing (~/.anthropic/config)'}`);
      break;
    case 'openai':
      console.log(`  Key:      ${findOpenAIKey() ? '✓ found' : '✗ missing (OPENAI_API_KEY)'}`);
      break;
    case 'ollama':
      console.log(`  URL:      ${OLLAMA_URL}  model=${OLLAMA_MODEL}`);
      break;
    case 'chatgpt':
      console.log(`  Token:    ${CHATGPT_TOKEN ? '✓ set' : '✗ missing (CHATGPT_SESSION_TOKEN)'}`);
      break;
  }
  console.log(`  Switch:   AI_PROXY_BACKEND=ollama node server/codex-proxy.js`);
  console.log();
});
