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
