#!/usr/bin/env node
// Terminal Server — WebSocket shell in the browser + bidirectional file sync.
// Uses CommonJS so Node.js resolves node_modules from texlyre/ correctly.
//
// Protocol (JSON messages):
//   client → server:
//     {type:'input', data}            terminal keystrokes
//     {type:'resize', cols, rows}     terminal resize
//     {type:'write-file', path, content}  upload/update a project file
//     {type:'delete-file', path}      delete a project file
//   server → client:
//     {type:'file-changed', path, content}  external change on disk (e.g. codex agent)
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

// Never crash the process on unhandled errors — log and keep serving
process.on('uncaughtException', (err) => {
  console.error('  [crash] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('  [crash] unhandledRejection:', err);
});

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

// ---- File sync helpers ----
function safeResolve(base, rel) {
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// Self-written files: suppress echo broadcast
const selfWrites = new Map(); // absPath → mtimeMs

function writeFileSync(cwd, relPath, content, encoding) {
  const abs = safeResolve(cwd, relPath);
  if (!abs) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (encoding === 'base64') {
    fs.writeFileSync(abs, Buffer.from(content, 'base64'));
  } else {
    fs.writeFileSync(abs, content, 'utf8');
  }
  try {
    selfWrites.set(abs, fs.statSync(abs).mtimeMs);
  } catch {}
  return true;
}

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

  // ---- File sync: watch project dir for external changes (e.g. codex) ----
  const watcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
    if (!filename || closed) return;
    const relPath = filename.toString();
    const abs = safeResolve(cwd, relPath);
    if (!abs) return;

    // Skip our own writes (echo suppression)
    try {
      const mtime = fs.statSync(abs).mtimeMs;
      if (selfWrites.get(abs) === mtime) {
        selfWrites.delete(abs);
        return;
      }
    } catch { return; }

    // Send changed file content back to the browser
    try {
      const content = fs.readFileSync(abs, 'utf8');
      ws.send(JSON.stringify({ type: 'file-changed', path: relPath, content }));
      console.log(`  [sync] file changed on disk: ${relPath}`);
    } catch {}
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'input':
          term.write(msg.data);
          break;
        case 'resize':
          term.resize(msg.cols, msg.rows);
          break;
        case 'write-file':
          if (typeof msg.path === 'string' && typeof msg.content === 'string') {
            writeFileSync(cwd, msg.path, msg.content, msg.encoding);
            console.log(`  [sync] wrote: ${msg.path}`);
          }
          break;
        case 'delete-file':
          if (typeof msg.path === 'string') {
            const abs = safeResolve(cwd, msg.path);
            if (abs && fs.existsSync(abs)) {
              fs.unlinkSync(abs);
              console.log(`  [sync] deleted: ${msg.path}`);
            }
          }
          break;
      }
    } catch {}
  });

  ws.on('close', () => {
    closed = true;
    term.kill();
    try { watcher.close(); } catch {}
    console.log(`  [terminal] disconnect (${wss.clients.size - 1} active)`);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`\nTerminal server running on ws://0.0.0.0:${PORT}`);
  console.log(`  Default cwd: ${DEFAULT_CWD}`);
  console.log();
});
