#!/usr/bin/env node
/**
 * Yjs WebSocket server — centralized document sync for TeXlyre.
 *
 * All users connect to this server instead of P2P WebRTC.
 * Documents are persisted to disk under ./.yjs-data/
 *
 * Usage:  node server/yjs-ws-server.js [port]
 */

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const PORT = parseInt(process.argv[2] || '8082', 10);
const PERSIST_DIR = './.yjs-data';

// message types (from y-protocols)
const messageSync = 0;
const messageAwareness = 1;

// ---- Doc persistence ----
const docs = new Map();

function docPath(docId) {
  if (!existsSync(PERSIST_DIR)) mkdirSync(PERSIST_DIR, { recursive: true });
  return join(PERSIST_DIR, `${encodeURIComponent(docId)}.yjs`);
}

function getDoc(docId) {
  if (docs.has(docId)) return docs.get(docId);
  const doc = new Y.Doc();
  const path = docPath(docId);
  try {
    const data = readFileSync(path);
    Y.applyUpdate(doc, data);
    console.log(`  [load] ${docId} (${(data.length / 1024).toFixed(1)} KB)`);
  } catch {
    console.log(`  [new]  ${docId}`);
  }
  doc.on('update', () => {
    const state = Y.encodeStateAsUpdate(doc);
    writeFileSync(docPath(docId), state);
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

function encodeMessage(type, payload) {
  const arr = new Uint8Array(payload.length + 1);
  arr[0] = type;
  arr.set(payload, 1);
  return Buffer.from(arr);
}

server.listen(PORT, () => {
  console.log(`\nYjs WebSocket server running on ws://0.0.0.0:${PORT}`);
  console.log(`  Persistence: ${PERSIST_DIR}/\n`);
});
