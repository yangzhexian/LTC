// Quick protocol test: start the real yjs-ws-server.js logic + connect a client
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.resolve(__dirname, '../server/yjs-ws-server.js');

// Start the actual server script
const proc = spawn('node', [SERVER, '18082'], {
  env: { ...process.env, NODE_PATH: path.resolve(__dirname, 'node_modules') },
});

let serverOut = '';
proc.stdout.on('data', (d) => {
  serverOut += d.toString();
  process.stdout.write('[server] ' + d);
});
proc.stderr.on('data', (d) => {
  serverOut += d.toString();
  process.stdout.write('[server-err] ' + d);
});

setTimeout(() => {
  // Connect a y-websocket client
  const { WebsocketProvider } = require('y-websocket');
  const Y = require('yjs');
  const doc = new Y.Doc();
  const provider = new WebsocketProvider('ws://localhost:18082', 'test-room', doc);

  provider.on('sync', (synced) => {
    console.log('CLIENT sync:', synced);
    if (synced) {
      doc.getMap('x').set('hello', 'world');
      setTimeout(() => {
        console.log('CLIENT TEST OK — server still alive:', proc.exitCode === null);
        proc.kill();
        process.exit(0);
      }, 1500);
    }
  });

  setTimeout(() => {
    console.log('TIMEOUT — server alive:', proc.exitCode === null);
    console.log('--- server output so far ---');
    console.log(serverOut);
    proc.kill();
    process.exit(1);
  }, 10000);
}, 1500);
