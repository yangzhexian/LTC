## LTC v0.1.0-alpha

Self-hosted, Overleaf-like real-time LaTeX/Typst collaboration platform for LAN/private servers,
**built on [TeXlyre](https://github.com/texlyre/texlyre)** (AGPL-3.0).

### Highlights

- **Centralized Yjs WebSocket server** — no public WebRTC signaling, all sync through your own Linux box
- **Browser terminal** — run `codex`, `latexmk`, `git` directly in the editor (node-pty + xterm.js)
- **Agent file sync** — bidirectional browser ↔ server file sync with 3-way merge conflict handling
- **SyncTeX** — PDF ↔ TeX jumping via the BusyTeX engine (default)
- **Server-side persistence** — Yjs docs survive restarts (`.yjs-data/`)
- **HTTP-friendly auth** — works over plain HTTP on LAN IPs (SHA-256 fallback + UUID polyfill)

### Quick start

```bash
git clone https://github.com/yangzhexian/LTC.git
cd LTC
bash server/start.sh        # builds + starts tmux session with 3 services
# open http://<server-ip>:8080/texlyre/
```

See README.md for full documentation.

### Known limitations (alpha)

- Accounts are stored per-browser (TeXlyre local-first design); share project links for collaboration
- File tree sync depends on the agent channel (both sides must connect at least once)
- Conflict resolution for overlapping text edits uses git-style markers (manual resolve)
- `yjs_metadata` connection flapping has been observed intermittently — under investigation

### Disclaimer

This is a fork of [TeXlyre](https://github.com/texlyre/texlyre) (AGPL-3.0). All upstream licenses apply.
