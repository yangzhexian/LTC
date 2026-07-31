#!/usr/bin/env node
// Yjs WebSocket server — centralized document sync for TeXlyre.
// CommonJS so Node.js resolves node_modules from texlyre/ correctly.
//
// Usage:  cd texlyre && node ../server/yjs-ws-server.js [port]

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { WebSocketServer } = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');

const PORT = parseInt(process.argv[2] || '8082', 10);
const PERSIST_DIR = path.join(__dirname, '..', '.yjs-data');

// message types (from y-protocols)
const messageSync = 0;
const messageAwareness = 1;

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
  doc.on('update', () => {
    const state = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(docPath(docId), state);
  });
  docs.set(docId, doc);
  return doc;
}

// ---- Track connectors per doc ----
const docConnectors = new Map(); // docId → Set<{ws, awareness}>

function getConnectors(docId) {
  if (!docConnectors.has(docId)) docConnectors.set(docId, new Set());
  return docConnectors.get(docId);
}

function encodeMessage(type, payload) {
  const arr = new Uint8Array(payload.length + 1);
  arr[0] = type;
  arr.set(payload, 1);
  return Buffer.from(arr);
}

// ---- HTTP + WebSocket server ----
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Yjs WebSocket server\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const docId = url.pathname.replace(/^\//, '') || 'default';
  const doc = getDoc(docId);
  const awareness = new awarenessProtocol.Awareness(doc);
  const connectors = getConnectors(docId);
  const connector = { ws, awareness };
  connectors.add(connector);

  console.log(`  [join] ${docId}  (total: ${connectors.size})`);

  // Forward awareness changes to all other clients in the same doc
  awareness.on('update', ({ added, removed, updated }, conn) => {
    const changed = [...added, ...removed, ...updated];
    const encoder = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
    for (const c of connectors) {
      if (c.ws !== ws && c.ws.readyState === 1) {
        c.ws.send(encodeMessage(messageAwareness, encoder));
      }
    }
  });

  ws.on('message', (data) => {
    const decoder = new Uint8Array(data);
    const messageType = decoder[0];

    switch (messageType) {
      case messageSync: {
        const encoder = syncProtocol.readSyncMessage(decoder, doc, null);
        if (encoder.length > 1) {
          ws.send(encodeMessage(messageSync, encoder));
        }
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoder, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    awarenessProtocol.cleanupAwareness(awareness);
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
