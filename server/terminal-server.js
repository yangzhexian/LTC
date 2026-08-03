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
// Auth:   if TERMINAL_TOKEN env is set, clients must connect with ?token=...
//         cwd is restricted to relative paths under ~/Projects/<projectId>.

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2] || '8084', 10);
const DEFAULT_CWD = path.resolve(process.argv[3] || '.');
// Port of the yjs-ws-server (for the /apply-file bridge)
const YJS_PORT = parseInt(process.env.YJS_PORT || '8082', 10);
// Shared auth token (Tier 1): server-internal, used ONLY for the /apply-file
// bridge to yjs-ws-server (and as WS auth on local agent machines, which have
// no sessions file). NOT distributed to browsers anymore.
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN || '';
// Tier 1: server-side accounts + project ACL. Auth mode is decided at
// startup: session mode when start.sh passes AUTH_MODE=session OR a
// server/.sessions.json exists (server deployment) — browsers must present a
// valid session token. Otherwise token mode (local agent machines) — the
// admin's TERMINAL_TOKEN is accepted instead.
const serverAuth = require('./auth');
const AUTH_MODE =
  process.env.AUTH_MODE === 'session' ||
  fs.existsSync(path.join(process.env.LTC_DATA_DIR || __dirname, '.sessions.json'))
    ? 'session'
    : 'token';
const auth = AUTH_MODE === 'session' ? serverAuth : null;

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
const selfDeletes = new Set(); // absPath deleted by our own delete-file handler

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
  let url = null;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host}`);
  } catch {}

  // ---- Tier 1 auth ----
  // Mode is decided once at startup:
  //  * session mode (server deployment): server/.sessions.json exists — the
  //    browser must present a valid session token (?session=...)
  //  * token mode (local agent machines): no sessions file — the admin's
  //    TERMINAL_TOKEN (from local-agent/config.json) is accepted instead
  const sessionUsername = AUTH_MODE === 'session'
    ? auth.validateSession(url?.searchParams.get('session') || '')
    : null;
  if (AUTH_MODE === 'session' && !sessionUsername) {
    console.log(`  [auth] REJECTED terminal connection from ${req.socket?.remoteAddress || 'unknown'} (no valid session)`);
    ws.close(4001, 'not authenticated');
    return;
  }
  if (AUTH_MODE === 'token') {
    const token = url?.searchParams.get('token') || '';
    if (TERMINAL_TOKEN && token !== TERMINAL_TOKEN) {
      console.log(`  [auth] REJECTED terminal connection from ${req.socket?.remoteAddress || 'unknown'} (missing/wrong token)`);
      ws.close(4001, 'invalid token');
      return;
    }
  }

  // Client can request a working directory via ?cwd= query param.
  // SECURITY: only relative paths under ~/Projects/<projectId> are allowed —
  // absolute paths and ".." traversal are rejected.
  let cwd = DEFAULT_CWD;
  let cwdProjectId = null;
  try {
    const requested = url?.searchParams.get('cwd');
    if (requested) {
      const isProjectCwd =
        !path.isAbsolute(requested) &&
        !requested.split(/[\\/]/).includes('..') &&
        (requested === 'Projects' || requested.startsWith('Projects/'));
      if (!isProjectCwd) {
        console.log(`  [auth] REJECTED terminal connection from ${req.socket?.remoteAddress || 'unknown'} (invalid cwd: ${requested})`);
        ws.close(4001, 'invalid cwd');
        return;
      }
      cwdProjectId = requested === 'Projects' ? null : requested.split('/')[1] || null;
      // ---- Project ACL: members only (session mode) ----
      if (AUTH_MODE === 'session' && cwdProjectId && !auth.isProjectMember(cwdProjectId, sessionUsername)) {
        console.log(`  [auth] REJECTED terminal connection from ${sessionUsername} to project ${cwdProjectId} (not a member)`);
        ws.close(4001, 'not a project member');
        return;
      }
      cwd = path.join(os.homedir(), requested);
      if (!fs.existsSync(cwd)) {
        fs.mkdirSync(cwd, { recursive: true });
        console.log(`  [terminal] created cwd: ${cwd}`);
      }
    }
  } catch {}

  console.log(`  [terminal] connect (${wss.clients.size} active), cwd: ${cwd}${AUTH_MODE === 'session' ? `, user: ${sessionUsername}` : ''}`);
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
      const buf = fs.readFileSync(abs);
      const ext = relPath.split('.').pop()?.toLowerCase() || '';

      // If the file is linked to a collaborative document, apply the change
      // into the Yjs room so ALL editors update in real time.
      // (yjs-ws-server owns the Yjs docs; we forward via its HTTP endpoint)
      if (TEXT_EXTENSIONS.has(ext)) {
        const projectId = path.basename(cwd);
        const content = buf.toString('utf8');
        fetch(`http://localhost:${YJS_PORT}/apply-file`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(TERMINAL_TOKEN ? { 'x-terminal-token': TERMINAL_TOKEN } : {}),
          },
          body: JSON.stringify({ projectId, path: relPath, content }),
        }).catch(() => {});
      }

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

    // File deleted on disk (external, e.g. agent rm) → tell browsers to remove it
    if (!fs.existsSync(abs)) {
      if (selfDeletes.has(abs)) {
        selfDeletes.delete(abs);
        return;
      }
      broadcastToProject(
        cwd,
        JSON.stringify({ type: 'file-deleted', path: relPath }),
        null,
      );
      console.log(`  [sync] file deleted on disk: ${relPath}`);
      return;
    }

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
              selfDeletes.add(abs);
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
