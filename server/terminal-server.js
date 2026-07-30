#!/usr/bin/env node
/**
 * Terminal Server — WebSocket shell in the browser.
 *
 * Each WebSocket connection gets a real bash session on the server
 * (via node-pty).  Users can run any command, including `codex`.
 *
 * Usage:  node server/terminal-server.js [port]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { homedir, hostname } from 'node:os';
import { resolve } from 'node:path';

const PORT = parseInt(process.argv[2] || '8084', 10);
const CWD = resolve(process.argv[3] || '.');

// ---- Minimal pty fallback: use raw spawn if node-pty not available ----
let spawnPty;
try {
  const pty = await import('node-pty');
  spawnPty = (cwd) => {
    const shell = process.env.SHELL || 'bash';
    const term = pty.default.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    return term;
  };
} catch {
  console.log('  node-pty not available; using raw child process (limited terminal support)');
  spawnPty = (cwd) => {
    const shell = process.env.SHELL || 'bash';
    const child = spawn(shell, [], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      onData: (cb) => { child.stdout.on('data', cb); child.stderr.on('data', cb); },
      write: (data) => child.stdin.write(data),
      resize: () => {},
      kill: () => child.kill(),
      onExit: (cb) => child.on('exit', cb),
    };
  };
}

// ---- HTTP server ----
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terminal WebSocket server\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`  [terminal] connect (${wss.clients.size} active)`);

  const term = spawnPty(CWD);
  let closed = false;

  term.onData((data) => {
    if (!closed) ws.send(data);
  });

  term.onExit((code) => {
    closed = true;
    ws.close();
    console.log(`  [terminal] exit code ${code}`);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'input') term.write(msg.data);
    if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
  });

  ws.on('close', () => {
    closed = true;
    term.kill();
    console.log(`  [terminal] disconnect (${wss.clients.size - 1} active)`);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`\nTerminal server running on ws://0.0.0.0:${PORT}`);
  console.log(`  CWD: ${CWD}`);
  console.log(`  Connect from browser via WebSocket to ws://host:${PORT}`);
  console.log();
});
