# LTC — Local TeX Collaboration Server

A **self-hosted, Overleaf-like real-time LaTeX/Typst collaboration platform** for
LAN or private-server use, built on top of [TeXlyre](https://github.com/texlyre/texlyre)
(AGPL-3.0).

> **Important**: This project is a fork/extended distribution of
> [TeXlyre](https://github.com/texlyre/texlyre) (a local-first LaTeX & Typst web
> editor with real-time collaboration). The core editor, WASM compilers
> (SwiftLaTeX / BusyTeX / typst.ts), Yjs CRDT collaboration and the plugin system
> are all TeXlyre's. This repo adds a **centralized server mode** and an
> **agent terminal** on top of it.

---

## What makes this different from upstream TeXlyre

| Feature | Upstream TeXlyre | This repo |
|---------|------------------|-----------|
| Collaboration transport | WebRTC P2P (public signaling) | **Centralized Yjs WebSocket server** (`server/yjs-ws-server.js`) |
| LaTeX engine | SwiftLaTeX (no SyncTeX) | **BusyTeX by default** (SyncTeX PDF↔TeX works) |
| Terminal | none | **Browser terminal** (`server/terminal-server.js` + xterm.js panel) — run `codex`, `latexmk`, `git` in-browser |
| AI/agent file sync | none | **Bidirectional file sync** between browser IndexedDB and server `~/Projects/<id>/`, with 3-way merge on conflicts |
| Docs persistence | browser IndexedDB only | Server-side `.yjs-data/` persistence |
| Registration | browser-local accounts | browser-local accounts (per-browser; see FAQ) |

---

## Architecture

```
Linux Server
├── HTTP :8080  — TeXlyre web app (vite preview of dist, base /texlyre/)
├── WS   :8082  — Yjs WebSocket server (document sync + persistence + /apply-file bridge)
├── WS   :8084  — Terminal server (node-pty shell + bidirectional file sync)
└── ~/Projects/<projectId>/ — project working directory shared with the terminal

Users → open http://<server-ip>:8080/texlyre/ → register/login → real-time editing
```

### Collaboration flow

```
Editor typing (linked .tex)  → Yjs CRDT → WebSocket :8082 → all connected editors
Agent edits on disk          → fs.watch → :8084 → /apply-file → Yjs doc → editors
                            → file-changed → other browsers' IndexedDB → file tree
Browser save                → write-file → server dir → broadcast to other browsers
Delete (either side)        → delete-file / file-deleted → both sides removed
```

### Conflict handling

- **Linked documents** (`.tex`, `.bib`): Yjs CRDT — automatic merge, nothing lost.
- **Unlinked files** (via file sync): 3-way merge on text conflicts
  (`<<<<<<< local / ======= / >>>>>>> remote` markers if overlapping),
  binary conflicts keep local + backup the incoming version.
- Echo suppression + content-diff uploads prevent sync loops.

---

## Quick Start

### Server (Ubuntu/Debian example)

```bash
# Requirements: Node.js >= 20, tmux, build-essential, git
git clone https://github.com/yangzhexian/LTC.git ~/LTC
cd ~/LTC
bash server/start.sh
```

`start.sh` will:
1. Install dependencies and build the web app (generates plugins, bundles)
2. Start the three services in a tmux session `texlyre-server`
3. Print the access URL and verify the ports are listening

### Users

1. Open `http://<server-ip>:8080/texlyre/` in a modern browser (Chrome/Edge recommended)
2. Register an account (stored per-browser; first visit configures WebSocket mode automatically)
3. Create a project or open a shared link (`#yjs:<projectId>`) to collaborate

### Terminal / Agent

In any project, switch to the **Terminal** tab (in the output panel) to get a real
shell in `~/Projects/<projectId>/`:

```bash
codex "rewrite the introduction of jrnl.tex to be more formal"
latexmk -pdf main.tex
```

Agent edits appear in every collaborator's editor in real time (linked documents
via Yjs; other files via the file channel).

### Security (Tier 0)

By default the server enforces a **shared token** on both WebSocket ports and
the `/apply-file` bridge:

- `server/start.sh` generates `server/.terminal-token` on first run and
  injects it into the web app (`userdata.json`) + server processes
- Connections without `?token=` are rejected and logged
- The terminal working directory is restricted to relative paths under
  `~/Projects/<projectId>` (absolute paths and `..` traversal are rejected)
- Scope: protects against port scanners and anyone who knows the server IP
  but isn't a user of the app. It is **not** a real account system — the token
  ships with the web app, so legitimate users can extract it. For stronger
  protection (server-side accounts, per-project ACL, TLS), see the roadmap.

### SyncTeX

- **PDF → TeX**: double-click on PDF text (enable via the floating SourceMap button)
- **TeX → PDF**: SourceMap button in the editor toolbar
- Requires the **BusyTeX** engine (default), which generates `.synctex` data.

---

## Project Structure

```
LTC/
├── server/
│   ├── start.sh           # One-command launcher (build + tmux + verify)
│   ├── yjs-ws-server.js   # Yjs WebSocket server (sync, persistence, /apply-file)
│   └── terminal-server.js # Browser terminal + bidirectional file sync (node-pty)
├── texlyre/               # TeXlyre fork (editor, WASM compilers, plugins)
│   ├── src/
│   │   ├── components/ai/TerminalPanel.tsx   # Terminal tab (xterm.js)
│   │   ├── styles/components/terminal.css    # Terminal theming
│   │   ├── services/AuthService.ts           # + pure-JS SHA-256 fallback (HTTP origins)
│   │   ├── contexts/ChatContext.tsx          # + WebSocket provider support
│   │   ├── contexts/FileSyncContext.tsx      # + WebSocket provider support
│   │   └── main.tsx                          # + crypto.randomUUID polyfill
│   ├── userdata.server.json  # Server preset (WebSocket mode, BusyTeX, FilePizza off)
│   └── ...
├── README.md
└── .gitignore
```

### Our modifications to TeXlyre (summary)

- **Centralized collaboration**: `ChatContext` / `FileSyncContext` honor the
  `collab-provider-type` setting (WebSocket), so no public WebRTC signaling is used.
- **HTTP-compatible auth**: pure-JS SHA-256 fallback + `crypto.randomUUID`
  polyfill — registration works over plain HTTP (LAN IPs).
- **Terminal panel**: xterm.js tab inside the LaTeX/Typst output panel, themed
  light/dark, fixed monospace font, connects to `server/terminal-server.js`.
- **Agent file sync**: bidirectional file tree ↔ server directory sync with
  content-diff uploads, echo suppression, 3-way merge, delete sync.
- **Server preset** (`userdata.server.json`): WebSocket mode, BusyTeX engine
  (SyncTeX), FilePizza disabled, public TeX Live endpoints.
- **Crash-proofing**: uncaughtException handlers in both servers, tmux
  `remain-on-exit`, self-healing restart in `start.sh`.

---

## FAQ

**Accounts are stored per-browser — why?**
That's TeXlyre's local-first design (IndexedDB). To collaborate, share the project
link (`#yjs:<projectId>`) — document content syncs through the server; file trees
sync via the agent channel. Accounts themselves are browser-local.

**Can I edit without linking files?**
Yes — unlinked files sync via the file channel (content snapshots). Linking
(`.tex`/`.bib`) additionally enables real-time CRDT editing with live cursors.

**Firewall / network**
Open ports 8080 (HTTP), 8082 (Yjs WS), 8084 (Terminal WS):
```bash
sudo ufw allow 8080/tcp && sudo ufw allow 8082/tcp && sudo ufw allow 8084/tcp
```

**License**
This project is licensed under **AGPL-3.0** (inherited from TeXlyre). Any
network-accessible deployment must make the source of the modified software
available to users.

---

## Acknowledgements

- [TeXlyre](https://github.com/texlyre/texlyre) — the foundation this project extends (AGPL-3.0)
- [Yjs](https://github.com/yjs/yjs), [y-websocket](https://github.com/yjs/y-websocket) — CRDT sync
- [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX), [BusyTeX](https://github.com/busytex/busytex) — in-browser TeX
- [xterm.js](https://github.com/xtermjs/xterm.js), [node-pty](https://github.com/microsoft/node-pty) — browser terminal
- [node-diff3](https://github.com/bhousel/node-diff3) — conflict merging
