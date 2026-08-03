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
// Shared auth token (Tier 0 protection): WebSocket clients must pass
// ?token= in the URL; /apply-file must send an x-terminal-token header.
// Empty string = auth disabled (local/dev only).
const TERMINAL_TOKEN = process.env.TERMINAL_TOKEN || '';
// Site access token (web UI entry gate): entered at server startup, the
// frontend must verify against GET /api/site-access before rendering.
// Empty string = gate disabled.
const SITE_TOKEN = process.env.SITE_TOKEN || '';

function tokenValid(candidate) {
  return !TERMINAL_TOKEN || (typeof candidate === 'string' && candidate === TERMINAL_TOKEN);
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
  // Web UI entry gate: the frontend verifies the site access token here
  // before rendering the app (GET /api/site-access?token=...)
  if (req.method === 'GET' && req.url.startsWith('/api/site-access')) {
    siteAccessHandler(req, res);
    return;
  }

  // Endpoint for the terminal server to push agent file changes into Yjs docs
  if (req.method === 'POST' && req.url === '/apply-file') {
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
  // ---- Auth gate: reject connections without the shared token ----
  if (!tokenValid(url.searchParams.get('token'))) {
    console.log(`  [auth] REJECTED yjs connection from ${req.socket?.remoteAddress || 'unknown'} (missing/wrong token)`);
    ws.close(4001, 'invalid token');
    return;
  }
  const docId = url.pathname.replace(/^\//, '') || 'default';
  const doc = getDoc(docId);
  const awareness = new awarenessProtocol.Awareness(doc);
  const connectors = getConnectors(docId);
  const connector = { ws, awareness };
  connectors.add(connector);

  console.log(`  [join] ${docId}  (total: ${connectors.size})`);

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
