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

// ---- Track connections per working directory (for cross-client file sync) ----
const activeConnections = new Set(); // { ws, cwd }

function broadcastToProject(cwd, message, excludeWs) {
  for (const conn of activeConnections) {
    if (conn.ws !== excludeWs && conn.cwd === cwd && conn.ws.readyState === 1) {
      conn.ws.send(message);
    }
  }
}

// File content encoding helpers (mirror of the browser's TEXT_EXTENSIONS)
const FILE_TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'sty', 'cls', 'txt', 'md', 'log', 'aux', 'cfg', 'def',
  'lst', 'py', 'sh', 'json', 'yml', 'yaml', 'csv', 'xml', 'html', 'css', 'js',
  'out', 'toc', 'fdb_latexmk', 'fls', 'blg', 'bbl', 'nav', 'snm', 'vrb', 'xdv',
]);

function encodeFileChangeMessage(abs, relPath) {
  const buf = fs.readFileSync(abs);
  const ext = relPath.split('.').pop()?.toLowerCase() || '';
  if (FILE_TEXT_EXTENSIONS.has(ext)) {
    return JSON.stringify({ type: 'file-changed', path: relPath, content: buf.toString('utf8') });
  }
  return JSON.stringify({ type: 'file-changed', path: relPath, content: buf.toString('base64'), encoding: 'base64' });
}

// ---- File sync helpers ----
function walkDir(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(abs, base, out);
    } else {
      out.push(path.relative(base, abs).replace(/\\/g, '/'));
    }
  }
  return out;
}

const TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'sty', 'cls', 'txt', 'md', 'log', 'aux', 'cfg', 'def',
  'lst', 'py', 'sh', 'json', 'yml', 'yaml', 'csv', 'xml', 'html', 'css', 'js',
  'out', 'toc', 'fdb_latexmk', 'fls', 'blg', 'bbl', 'nav', 'snm', 'vrb', 'xdv',
]);

function safeResolve(base, rel) {
  // Client paths look like "/jrnl.tex" — strip leading slashes, treat as relative
  const clean = String(rel).replace(/^\/+/, '');
  const abs = path.resolve(base, clean);
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
  activeConnections.add({ ws, cwd });
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
  // Debounce per-path so rapid writes (latexmk, codex) coalesce into one push
  const pendingPushes = new Map(); // absPath → timer

  const pushFileChange = (abs, relPath) => {
    if (closed) return;
    try {
      // Broadcast to ALL browsers in this project (agent changes are shared)
      broadcastToProject(cwd, encodeFileChangeMessage(abs, relPath), null);
      console.log(`  [sync] file changed on disk: ${relPath}`);
    } catch {}
  };

  const isTempFile = (name) =>
    name.endsWith('.swp') || name.endsWith('.tmp') || name.endsWith('~') ||
    name.includes('.#') || name.startsWith('.#') || name.endsWith('.fuse_hidden');

  const watcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
    if (!filename || closed) return;
    const relPath = filename.toString().replace(/^\/+/, '');
    const abs = safeResolve(cwd, relPath);
    if (!abs) return;
    if (isTempFile(relPath)) return;

    // Echo suppression: skip events whose mtime is <= our last self-write.
    // IMPORTANT: do NOT delete the selfWrites entry — multiple watchers
    // (one per connected browser) may process the same event; deleting the
    // entry would make the next watcher treat it as an external change,
    // causing an infinite upload/broadcast loop.
    try {
      const mtime = fs.statSync(abs).mtimeMs;
      const selfMtime = selfWrites.get(abs);
      if (selfMtime !== undefined && mtime <= selfMtime) {
        return;
      }
    } catch {
      // File may be deleted or mid-write (rename events) — ignore
      return;
    }

    // Debounce: replace any pending push for this path
    if (pendingPushes.has(abs)) clearTimeout(pendingPushes.get(abs));
    pendingPushes.set(
      abs,
      setTimeout(() => {
        pendingPushes.delete(abs);
        pushFileChange(abs, relPath);
      }, 150),
    );
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
            const ok = writeFileSync(cwd, msg.path, msg.content, msg.encoding);
            console.log(`  [sync] ${ok ? 'wrote' : 'REJECTED'}: ${msg.path}`);
            if (ok) {
              // Cross-client sync: broadcast the file to OTHER browsers in the
              // same project (the writing browser already has it).
              try {
                const abs = safeResolve(cwd, msg.path);
                if (abs) {
                  broadcastToProject(cwd, encodeFileChangeMessage(abs, msg.path.replace(/^\/+/, '')), ws);
                }
              } catch {}
            }
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
        case 'list-files':
          // Pull request: send the current project directory contents to the
          // requesting browser (enables new collaborators to fetch files even
          // when no other browser is online).
          {
            const files = walkDir(cwd, cwd, []);
            let sent = 0;
            for (const rel of files) {
              if (isTempFile(rel)) continue;
              try {
                const abs = safeResolve(cwd, rel);
                if (!abs) continue;
                ws.send(encodeFileChangeMessage(abs, rel));
                sent++;
              } catch {}
            }
            console.log(`  [sync] listed ${sent} files to client`);
          }
          break;
      }
    } catch {}
  });

  ws.on('close', () => {
    closed = true;
    term.kill();
    try { watcher.close(); } catch {}
    for (const timer of pendingPushes.values()) clearTimeout(timer);
    pendingPushes.clear();
    for (const conn of activeConnections) {
      if (conn.ws === ws) {
        activeConnections.delete(conn);
        break;
      }
    }
    console.log(`  [terminal] disconnect (${wss.clients.size - 1} active)`);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`\nTerminal server running on ws://0.0.0.0:${PORT}`);
  console.log(`  Default cwd: ${DEFAULT_CWD}`);
  console.log();
});
