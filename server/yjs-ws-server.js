#!/usr/bin/env node
// Yjs WebSocket server — centralized document sync for TeXlyre.
// Follows the official y-websocket server protocol implementation.
//
// Usage:  NODE_PATH=<texlyre>/node_modules node server/yjs-ws-server.js [port]

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { WebSocketServer } = require('ws');
const Y = require('yjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');

const PORT = parseInt(process.argv[2] || '8082', 10);
const PERSIST_DIR = path.join(__dirname, '..', '.yjs-data');
// Shared auth token (Tier 1: server-internal only — terminal-server → us,
// for the /apply-file bridge). NOT distributed to browsers anymore.
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN || '';
// Site access token (web UI entry gate): entered at server startup, the
// frontend must verify against GET /api/site-access before rendering.
// Empty string = gate disabled.
const SITE_TOKEN = process.env.SITE_TOKEN || '';
// Tier 1: server-side accounts + sessions + project ACL
const auth = require('./auth');
auth.init();

function tokenValid(candidate) {
  return !TERMINAL_TOKEN || (typeof candidate === 'string' && candidate === TERMINAL_TOKEN);
}

// ---- Room name → projectId (ACL) ----
// Rooms are "<projectId>-<collection>" with collections: yjs_<docId>,
// yjs_metadata, chat, file_sync. Rooms without a known suffix (e.g. "default",
// account-sync rooms) are not project-bound and stay open to authenticated users.
function parseProjectId(room) {
  if (typeof room !== 'string' || !room) return null;
  const m = room.match(/^(.+?)(?:-yjs_|-chat$|-file_sync$)/);
  return m ? m[1] : null;
}

// ---- Site access gate (web UI entry token) ----
// Simple per-IP throttle: after N wrong tokens, block the IP for a while.
const SITE_MAX_FAILURES = 10;
const SITE_BLOCK_MS = 10 * 60 * 1000;
const siteFailures = new Map(); // ip → { count, until }

function siteAccessHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // No token configured on the server → gate open
  if (!SITE_TOKEN) {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const ip = req.socket?.remoteAddress || 'unknown';
  const entry = siteFailures.get(ip) || { count: 0, until: 0 };

  if (Date.now() < entry.until) {
    res.writeHead(429);
    res.end(JSON.stringify({ ok: false, error: 'too many attempts' }));
    return;
  }

  let token = '';
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    token = url.searchParams.get('token') || '';
  } catch {}

  if (token === SITE_TOKEN) {
    siteFailures.delete(ip);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  entry.count += 1;
  if (entry.count >= SITE_MAX_FAILURES) {
    entry.until = Date.now() + SITE_BLOCK_MS;
    entry.count = 0;
    console.log(`  [auth] site access blocked for ${ip} (${SITE_MAX_FAILURES} failed attempts)`);
  }
  siteFailures.set(ip, entry);
  console.log(`  [auth] REJECTED site access from ${ip} (wrong site token, attempt ${entry.count})`);
  res.writeHead(403);
  res.end(JSON.stringify({ ok: false }));
}

// ---- Tier 1: account / session / project ACL endpoints ----
// Same per-IP throttle as the site gate (shared buckets for login attempts).
const loginFailures = new Map(); // ip → { count, until }
const LOGIN_MAX_FAILURES = 10;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;

function throttle(ip, failures, maxFailures, blockMs) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  if (Date.now() < entry.until) return 'blocked';
  if (entry.count >= maxFailures) {
    entry.until = Date.now() + blockMs;
    entry.count = 0;
    failures.set(ip, entry);
    return 'blocked';
  }
  entry.count += 1;
  failures.set(ip, entry);
  return 'ok';
}

function clearThrottle(ip, failures) {
  failures.delete(ip);
}

function readBody(req, res, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 65536) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: 'body too large' }));
      req.destroy();
      return;
    }
  });
  req.on('end', () => {
    try {
      cb(JSON.parse(body || '{}'));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid JSON' }));
    }
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function apiCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function handleAuthApi(req, res, pathname, query) {
  if (apiCors(req, res)) return;
  const ip = req.socket?.remoteAddress || 'unknown';

  if (req.method === 'POST' && pathname === '/api/register') {
    readBody(req, res, (b) => {
      const { username, password, inviteCode } = b;
      const result = auth.registerUser(username, password, inviteCode);
      if (!result.ok) {
        json(res, 400, result);
        return;
      }
      // Auto-login after registration so the client gets a session token
      const loginResult = auth.loginUser(username, password);
      json(res, 200, {
        ok: true,
        user: loginResult.user,
        token: loginResult.token,
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    readBody(req, res, (b) => {
      if (throttle(ip, loginFailures, LOGIN_MAX_FAILURES, LOGIN_BLOCK_MS) === 'blocked') {
        console.log(`  [auth] login blocked for ${ip} (too many attempts)`);
        json(res, 429, { ok: false, error: 'too many attempts' });
        return;
      }
      const result = auth.loginUser(b.username, b.password);
      if (result.ok) clearThrottle(ip, loginFailures);
      else console.log(`  [auth] FAILED login attempt from ${ip} (${b.username})`);
      json(res, result.ok ? 200 : 401, result);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    readBody(req, res, (b) => {
      const was = auth.logoutToken(b.token);
      json(res, 200, { ok: was });
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const username = auth.validateSession(query.get('token'));
    if (!username) {
      json(res, 401, { ok: false, error: 'invalid session' });
      return;
    }
    json(res, 200, { ok: true, user: { username } });
    return;
  }

  // ---- project ACL ----
  if (pathname === '/api/projects' || pathname === '/api/projects/share' || pathname === '/api/projects/unshare') {
    const requireUser = (token, cb) => {
      const username = token ? auth.validateSession(token) : null;
      if (!username) {
        json(res, 401, { ok: false, error: 'invalid session' });
        return;
      }
      cb(username);
    };

    if (req.method === 'POST' && pathname === '/api/projects') {
      readBody(req, res, (b) => {
        requireUser(b.token, (username) => {
          if (!b.id || typeof b.id !== 'string') {
            json(res, 400, { ok: false, error: 'missing project id' });
            return;
          }
          const result = auth.registerProject(b.id, b.name, username);
          json(res, result.ok ? 200 : 403, result);
        });
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/projects/share') {
      readBody(req, res, (b) => {
        requireUser(b.token, (username) => {
          const result = auth.shareProject(b.id, b.username, username);
          json(res, result.ok ? 200 : 403, result);
        });
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/projects/unshare') {
      readBody(req, res, (b) => {
        requireUser(b.token, (username) => {
          const result = auth.unshareProject(b.id, b.username, username);
          json(res, result.ok ? 200 : 403, result);
        });
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      requireUser(query.get('token'), (username) => {
        json(res, 200, { ok: true, projects: auth.listProjectsFor(username) });
      });
      return;
    }
  }
}

// Never crash the process on unhandled errors — log and keep serving
process.on('uncaughtException', (err) => {
  console.error('  [crash] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('  [crash] unhandledRejection:', err);
});

// message types (from y-protocols)
const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

// ---- Doc persistence ----
const docs = new Map();

function docPath(docId) {
  if (!fs.existsSync(PERSIST_DIR)) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
  }
  return path.join(PERSIST_DIR, `${encodeURIComponent(docId)}.yjs`);
}

function getDoc(docId) {
  if (docs.has(docId)) return docs.get(docId);
  const doc = new Y.Doc();
  const p = docPath(docId);
  try {
    const data = fs.readFileSync(p);
    Y.applyUpdate(doc, data);
    console.log(`  [load] ${docId} (${(data.length / 1024).toFixed(1)} KB)`);
  } catch {
    console.log(`  [new]  ${docId}`);
  }
  // Persist state on every update
  doc.on('update', () => {
    const state = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(docPath(docId), state);
  });
  docs.set(docId, doc);
  return doc;
}

// ---- Connectors per doc ----
const docConnectors = new Map(); // docId → Set<{ws, awareness}>

function getConnectors(docId) {
  if (!docConnectors.has(docId)) docConnectors.set(docId, new Set());
  return docConnectors.get(docId);
}

// Broadcast a message to every connector except the origin
function broadcast(docId, message, origin) {
  const connectors = docConnectors.get(docId);
  if (!connectors) return;
  for (const c of connectors) {
    if (c.ws !== origin && c.ws.readyState === 1) {
      c.ws.send(message);
    }
  }
}

// ---- File → linked Yjs document bridge ----
// When the agent (or any external process) modifies a file on disk that is
// LINKED to a collaborative document, apply the change into the document's
// Yjs room. The doc update then broadcasts to every connected editor in
// real time (like a collaborator typing).
function applyToLinkedDoc(cwd, relPath, content) {
  try {
    const projectId = path.basename(cwd);
    if (!projectId) return false;

    // Load the project metadata doc (documents: [{id, name}]) where
    // document.name === file path for linked documents
    const metaRoom = `${projectId}-yjs_metadata`;
    const metaDoc = getDoc(metaRoom);
    const dataMap = metaDoc.getMap('data');
    const documents = dataMap.get('documents');
    if (!Array.isArray(documents)) return false;

    const texPath = `/${String(relPath).replace(/^\/+/, '')}`;
    const linked = documents.find((d) => d && d.name === texPath);
    if (!linked || !linked.id) return false;

    const room = `${projectId}-yjs_${linked.id}`;
    const doc = getDoc(room);
    const text = doc.getText('codemirror');
    const current = text.toString();
    if (current === content) return false;

    text.delete(0, current.length);
    text.insert(0, content);
    console.log(`  [sync] applied agent change into Yjs document: ${texPath}`);
    return true;
  } catch (err) {
    console.error('  [sync] applyToLinkedDoc failed:', err.message);
    return false;
  }
}

// ---- File → linked Yjs document bridge ----
// When the agent (or any external process) modifies a file on disk that is
// LINKED to a collaborative document, apply the change into the document's
// Yjs room. The doc update then broadcasts to every connected editor in
// real time (like a collaborator typing).
function applyToLinkedDoc(projectId, relPath, content) {
  try {
    if (!projectId) return false;

    // Load the project metadata doc (documents: [{id, name}]) where
    // document.name === file path for linked documents
    const metaRoom = `${projectId}-yjs_metadata`;
    const metaDoc = getDoc(metaRoom);
    const dataMap = metaDoc.getMap('data');
    const documents = dataMap.get('documents');
    if (!Array.isArray(documents)) return false;

    const texPath = `/${String(relPath).replace(/^\/+/, '')}`;
    const linked = documents.find((d) => d && d.name === texPath);
    if (!linked || !linked.id) return false;

    const room = `${projectId}-yjs_${linked.id}`;
    const doc = getDoc(room);
    const text = doc.getText('codemirror');
    const current = text.toString();
    if (current === content) return false;

    text.delete(0, current.length);
    text.insert(0, content);
    console.log(`  [sync] applied agent change into Yjs document: ${texPath}`);
    return true;
  } catch (err) {
    console.error('  [sync] applyToLinkedDoc failed:', err.message);
    return false;
  }
}

// ---- HTTP + WebSocket server ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Web UI entry gate: the frontend verifies the site access token here
  // before rendering the app (GET /api/site-access?token=...)
  if (req.method === 'GET' && pathname === '/api/site-access') {
    siteAccessHandler(req, res);
    return;
  }

  // Tier 1: accounts, sessions, project ACL
  if (pathname.startsWith('/api/')) {
    handleAuthApi(req, res, pathname, url.searchParams);
    return;
  }

  // Endpoint for the terminal server to push agent file changes into Yjs docs
  if (req.method === 'POST' && pathname === '/apply-file') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token =
          req.headers['x-terminal-token'] || url.searchParams.get('token') || '';
        if (!tokenValid(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid token' }));
          return;
        }
        const { projectId, path: relPath, content } = JSON.parse(body);
        const ok = applyToLinkedDoc(projectId, relPath, content);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Yjs WebSocket server\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const docId = url.pathname.replace(/^\//, '') || 'default';

  // ---- Tier 1 auth: browser connections need a valid server session ----
  // (the shared terminal token is server-internal now, NOT accepted here)
  const username = auth.validateSession(url.searchParams.get('session'));
  if (!username) {
    console.log(`  [auth] REJECTED yjs connection from ${req.socket?.remoteAddress || 'unknown'} (no valid session)`);
    ws.close(4001, 'not authenticated');
    return;
  }

  // ---- Project ACL: members only ----
  const projectId = parseProjectId(docId);
  if (projectId && !auth.isProjectMember(projectId, username)) {
    console.log(`  [auth] REJECTED yjs connection from ${username} to project ${projectId} (not a member)`);
    ws.close(4001, 'not a project member');
    return;
  }

  const doc = getDoc(docId);
  const awareness = new awarenessProtocol.Awareness(doc);
  const connectors = getConnectors(docId);
  const connector = { ws, awareness };
  connectors.add(connector);

  console.log(`  [join] ${docId} by ${username}  (total: ${connectors.size})`);

  // Broadcast doc updates to all OTHER clients
  const updateHandler = (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(docId, encoding.toUint8Array(encoder), ws);
  };
  doc.on('update', updateHandler);

  // Forward awareness changes to other clients
  awareness.on('update', ({ added, removed, updated }, conn) => {
    const changed = [...added, ...removed, ...updated];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    broadcast(docId, encoding.toUint8Array(encoder), ws);
  });

  // Ask the client for its state (sync step 1).
  // CRITICAL: the y-websocket client only uploads its local state (step 2)
  // in response to a step 1 from the server. Without this, clients with
  // pre-existing local state (e.g. project metadata) never push it to the
  // server, so new collaborators see an empty document.
  try {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  } catch {}

  // Handle incoming messages (official y-websocket protocol)
  ws.on('message', (message) => {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync: {
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, null);
        // Reply with the response (e.g. sync step 2, updates)
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          ws,
        );
        break;
      }
      case messageQueryAwareness: {
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            awareness,
            [...awareness.getStates().keys()],
          ),
        );
        ws.send(encoding.toUint8Array(encoder));
        break;
      }
    }
  });

  ws.on('close', () => {
    awareness.destroy();
    doc.off('update', updateHandler);
    connectors.delete(connector);
    console.log(`  [leave] ${docId}  (remaining: ${connectors.size})`);
    if (connectors.size === 0) docConnectors.delete(docId);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`\nYjs WebSocket server running on ws://0.0.0.0:${PORT}`);
  console.log(`  Persistence: ${PERSIST_DIR}/`);
  console.log();
});
