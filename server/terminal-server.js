#!/usr/bin/env node
// Terminal Server — WebSocket shell in the browser.
// Uses CommonJS so Node.js resolves node_modules from texlyre/ correctly.
//
// Usage:  cd texlyre && node ../server/terminal-server.js [port]

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2] || '8084', 10);
const DEFAULT_CWD = path.resolve(process.argv[3] || '.');

// ---- Try node-pty, fall back to raw spawn ----
let spawnPty;
try {
  const pty = require('node-pty');
  spawnPty = (cwd) => {
    const shell = process.env.SHELL || 'bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    return term;
  };
  console.log('  Using node-pty (full terminal support)');
} catch {
  console.log('  node-pty not available; using raw child process');
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
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terminal WebSocket server\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log(`  [terminal] connect (${wss.clients.size} active)`);

  // Client can request a working directory via ?cwd= query param
  // Relative paths are resolved against $HOME (e.g. "Projects/<projectId>")
  let cwd = DEFAULT_CWD;
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const requested = url.searchParams.get('cwd');
    if (requested) {
      cwd = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.join(os.homedir(), requested);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        console.log(`  [terminal] created cwd: ${cwd}`);
      }
    }
  } catch {}

  console.log(`  [terminal] cwd: ${cwd}`);
  const term = spawnPty(cwd);
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
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'input') term.write(msg.data);
      if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
    } catch {}
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
  console.log(`  Default cwd: ${DEFAULT_CWD}`);
  console.log();
});
