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

### Security (Tier 1)

Two layers protect the server:

**1. Server-side accounts + sessions** — the web app opens on a **login
screen**: visitors must sign in with a **server account** (register requires
the admin's **invite code**, set at startup in `server/.invite-code`, or
accounts can be pre-created with the admin CLI). Login issues a random
session token (7-day sliding expiry, scrypt-hashed passwords, files stored in
`server/.users.json` / `server/.sessions.json`, git-ignored). All WebSocket
connections (Yjs sync + terminal) must present `?session=...` — **the session
token is never baked into the web app**. Sessions are remembered in
localStorage: returning browsers skip the login screen entirely, the session
heartbeat keeps active sessions alive (no mid-work logouts), and invalidated
sessions return you to the login screen instead of failing silently. Users
without a session can still open the app in local-only mode ("use locally").

**2. Project ACL** — projects are registered server-side on creation
(`POST /api/projects`, owner = creator, stored in `server/.projects.json`).
Yjs rooms and terminal working directories are only accessible to the owner
and invited members (`share`/`unshare` endpoints or the admin CLI). Unregistered
projects are rejected.

Admin CLI (`node server/manage-users.js`):
```
create-user <username> [password]    list-users    delete-user <username>
list-projects                        register-project <projectId> <owner> [name]
share <projectId> <username>         unshare <projectId> <username>
```

Notes:
- `server/.terminal-token` still exists but is **server-internal only**
  (terminal → yjs `/apply-file` bridge); it is no longer shipped to browsers.
- **Migrating from before Tier 1**: browser-local accounts cannot be imported
  (passwords were SHA-256 hashed in the browser and are unrecoverable) —
  users simply re-register with the invite code (or the admin runs
  `create-user`), keeping the same username if desired. Their projects are
  registered automatically on first sign-in (`syncProjectsToServer`), and
  projects created by other accounts can be migrated with the CLI:
  `register-project <id> <owner>`.
- Remaining roadmap: per-OS-user terminal isolation, TLS reverse proxy,
  connection rate limits, audit log.

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
│   ├── terminal-server.js # Browser terminal + bidirectional file sync (node-pty)
│   ├── auth.js            # Tier 1 accounts/sessions/project ACL (scrypt, files)
│   └── manage-users.js    # Admin CLI for accounts + project sharing
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
