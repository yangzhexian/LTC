# Local LaTeX Collaboration (LTC)

A zero-friction setup for real-time collaborative LaTeX editing on a remote server.

## Modes

| Mode | Description | When to use |
|------|-------------|-------------|
| **SSH + Live Share** (VS Code) | Host compiles via SSH, Guests edit via Live Share, PDF via HTTP | Simple, TeX Live already installed |
| **TeXlyre Server** (Browser) | Full Overleaf-like web editor with AI assistant | Real-time collab in browser, no VS Code needed |

---

## Quick Start — TeXlyre Server (Overleaf-like)

**Best for**: multiple users editing simultaneously via browser, no VS Code needed.

### Architecture

```
Linux Server
├── TeXlyre (React SPA)   —  http://localhost:8080
├── Yjs WebSocket Server   —  ws://localhost:8082  (document sync)
├── Terminal WebSocket     —  ws://localhost:8084  (shell: codex, latexmk, git...)
└── WASM LaTeX engines     —  in-browser, no TeX Live needed

Users → open http://server-ip:8080 in browser → real-time editing
```

### Start

```bash
git clone <repo-url> ~/ltc
cd ~/ltc
bash server/start.sh/
```

This starts three services in a tmux session `texlyre-server`:
1. **TeXlyre** — web app on port 8080
2. **Yjs WebSocket** — document sync on port 8082
3. **Codex proxy** — AI on port 8083

### User configuration

Each user opens `http://server-ip:8080` in their browser. First-time visitors
see the default project dashboard.  To collaborate:

1. User A creates a project → click **Share** → copy the link
2. User B opens the link in their browser → both edit in real-time
3. Each user's browser compiles LaTeX independently (WASM)

### Terminal (AI & more)

The browser terminal panel connects to a real shell on the server (port 8084).
Use it like VS Code's integrated terminal:

- Run `codex` — the full CLI agent, no proxy or API key needed
- Run `latexmk`, `git`, `python3`, or any command
- Everything runs inside the project directory

No configuration needed — just click the **Terminal** panel in the browser
and type your commands.

---

## Quick Start — SSH + Live Share (Original)

| Requirement | Notes |
|-------------|-------|
| Remote Linux server | TeX Live + python3 + tmux installed |
| VS Code | With extensions: Remote-SSH, LaTeX Workshop, Live Share |
| Guest VS Code | Only needs Live Share (extension auto-recommended via `.vscode/extensions.json`) |
| SSH access | Host connects via Remote-SSH |

---

## Quick Start

### 1. Clone & open

```bash
git clone <repo-url> ~/ltc
code ~/ltc
```

When prompted by VS Code, install the **Recommended Extensions** (LaTeX Workshop, Live Share).

### 2. One-click start (via VS Code Task)

Press **`Ctrl+Shift+B`** (Run Build Task) → selects **"Start All Services"**.

This launches three things **in sequence**:

1. **Initial Build** — runs `latexmk -pdf` once
2. **latexmk (continuous watch)** — watches all `.tex` files and recompiles on change
3. **HTTP Server** — serves project root on **port 8766**

Each runs in its own terminal tab inside the VS Code terminal panel.

> **Host**: Open the built-in PDF viewer (`Ctrl+Alt+V` → "View LaTeX PDF") for **SyncTeX** support — `Ctrl+Click` in PDF jumps to `.tex` source, `Ctrl+Alt+J` jumps from source to PDF.
>
> **Guests**: Browse to `http://localhost:8766/` — the PDF auto-refreshes every 2 seconds.

### 3. Share the port via Live Share

1. Click **"Live Share"** in the status bar (bottom-right) to start a session
2. Send the invite link to Guests (via chat, email, etc.)
3. Open **Command Palette** (`Ctrl+Shift+P`) → **"Live Share: Share Ports"**
4. Add port **`8766`**
5. Tell Guests to open **`http://localhost:8766/`** in their browser (PDF auto-refreshes every 2s)

---

## Alternative: Command-line start

If you prefer a terminal (or tmux):

```bash
cd ~/ltc
bash scripts/start.sh
```

This creates a tmux session named `ltc` with two windows — one for `latexmk -pvc` and one for the HTTP server.

---

## Files Structure

```
.
├── main.tex              # Root LaTeX document
├── bibliography.bib      # BibTeX references
├── figures/              # Images / PDF figures
│   └── placeholder.pdf
├── sections/             # Split .tex files (optional)
├── server/
│   ├── start.sh           # Centralized TeXlyre server launcher
│   ├── yjs-ws-server.js   # Yjs WebSocket server (document sync)
│   └── terminal-server.js # WebSocket shell terminal
├── scripts/
│   ├── httpserver.py     # Custom PDF-only HTTP server (auto-refresh)
│   ├── start.sh          # Single-project launcher (tmux-based)
│   └── manager.sh        # Multi-project manager (status/start/stop)
├── .vscode/
│   ├── settings.json     # LaTeX Workshop config (auto-build on save, built-in viewer)
│   ├── tasks.json        # VS Code Task: "Start All Services" / "SSH Mode"
│   └── extensions.json   # Recommended extensions
└── .gitignore
```

---

## How Guests Work

**Guests need ONLY:**

1. VS Code
2. Live Share extension (VS Code will recommend it when opening the project)
3. Accept the Host's Live Share invite

**They do NOT need:**
- TeX Live or any LaTeX installation
- SSH access
- Any project setup
- Any local build tools

**Workflow for Guests:**
1. Click the Live Share invite link → VS Code opens the project
2. Edit any `.tex` file — changes appear in real-time for everyone
3. Open **`http://localhost:8766/`** in a browser
4. The PDF auto-refreshes every ~2 seconds — no manual refresh needed

### Can Guests use SyncTeX (PDF ↔ TeX jumping)?

**No.** SyncTeX requires the `synctex` binary (part of TeX Live) and VS Code ↔ PDF viewer
integration, both of which are absent in a browser-based PDF viewer.

If a collaborator needs SyncTeX, they should connect to the server via **Remote-SSH**
(rather than, or in addition to, Live Share).  They will then have the full TeX Live
environment and LaTeX Workshop — exactly like the Host.  Live Share can still be used
alongside Remote-SSH for additional guests.

---

## Configuration Details

### How auto-compile works

LaTeX Workshop (in `settings.json`) is set to:

```json
"latex-workshop.latex.autoBuild.run": "onSave"
```

Every time any `.tex` file is saved (by any collaborator), `latexmk -pdflatex` runs automatically. The VS Code Task `latexmk (continuous watch)` also runs `latexmk -pvc` as a belt-and-suspenders watcher — it catches changes even if LaTeX Workshop's auto-build misses some edge case.

### PDF viewer enabled (Host) + HTTP server (Guests)

**Host**: The built-in LaTeX Workshop PDF viewer is enabled:
```json
"latex-workshop.view.pdf.viewer": "tab"
```
This gives the Host full **SyncTeX** support:
- **Forward search** (TeX → PDF): `Ctrl+Alt+J` — jumps from cursor position to the PDF
- **Backward search** (PDF → TeX): `Ctrl+Click` on PDF text — opens the corresponding `.tex` line

**Guests**: Access the PDF via `http://localhost:8766/` — the custom `httpserver.py` serves only `main.pdf` and an auto-refresh HTML wrapper (no SyncTeX, but the PDF updates automatically every ~2 seconds).

---

## Technical Traps & Solutions

### 1. `latexmk -pvc` on a headless server

**Problem:** `-pvc` tries to open a PDF viewer, which fails on a server without a GUI.

**Fix:** We override the previewer command in `tasks.json`:
```
-e '$pdf_previewer="cat";$pvc_view_file=0;'
```
This tells latexmk to use `cat` as the "viewer" (no-op) and not to wait for the viewer. Works fine headless.

### 2. Port conflict

**Problem:** Port 8766 is already in use.

**Fix:** Kill the old process or change the port:
```bash
# Find process on port 8766
ss -tlnp | grep 8766
# Kill it
kill <PID>
# Or use a different port:
python3 scripts/httpserver.py 8767
```

### 3. Browser cache

**Problem:** Guests refresh the browser but see an old PDF.

**Fix:** Force a hard refresh:
- **Chrome/Edge:** `Ctrl+Shift+R`
- **Firefox:** `Ctrl+Shift+R`
- **Or open DevTools → Network → check "Disable cache"**

For a permanent fix, you can disable caching in the HTTP server. The `start.sh` script does not disable caching by default; to do so, add a custom Python server (see `scripts/cached_http_server.py` as an exercise).

### 4. Guests see "Connection refused" at localhost:8766

**Cause:** The port was not shared via Live Share, or the Live Share session ended.

**Fix:** Host must re-share the port: Command Palette → "Live Share: Share Ports" → `8766`.

### 5. SyncTeX not working for Guests

**Problem:** Guests click on PDF text expecting to jump to `.tex` source.

**Fix:** SyncTeX is only available in LaTeX Workshop's built-in PDF viewer (Host side). Guests see a read-only PDF in the browser. This is by design — Guests edit `.tex` files directly in VS Code and use the HTTP PDF for visual reference only.

### 6. Firewall blocks the port

**Problem:** Guests want to access the server directly (without Live Share) but a firewall blocks port 8766.

**Fix (if applicable):**
```bash
sudo firewall-cmd --add-port=8766/tcp --permanent
sudo firewall-cmd --reload
```
Or use an SSH tunnel:
```bash
ssh -L 8766:localhost:8766 user@server
```

### 7. Auto-save vs manual save

**Setting:** `"files.autoSave": "onFocusChange"` — saves when you click out of a file.

- Guests who only browse and don't edit won't trigger saves
- Only the person who makes edits triggers a recompile
- Anyone can trigger a manual save with `Ctrl+S`

---

## SSH Hybrid Mode (Everyone Has SSH + SyncTeX)

If every collaborator has SSH access to the server, they can all enjoy **SyncTeX**
while still editing together via Live Share.

### Architecture

```
Everyone:  Remote-SSH + Live Share (edit) + LaTeX Workshop Viewer (SyncTeX)
One user:  runs shared latexmk -pvc (compilation)

No HTTP server needed — PDF is viewed directly via Remote-SSH.
```

### Setup

1. **Server**: ensure every collaborator has a Linux user account with TeX Live + tmux.
2. **Everyone** clones the project and opens via Remote-SSH:
   ```bash
   git clone <repo-url> ~/project
   code ~/project
   ```
3. **One person** (e.g. Host) starts the shared LaTeX watcher:
   - Press **`Ctrl+Shift+B`** → select **"SSH Mode: Shared LaTeX Watcher"**
   - This runs `Initial Build` + `latexmk (continuous watch)` — no HTTP server
4. **Everyone disables auto-build** in their own `settings.json` to prevent
   multiple simultaneous compilations:
   ```json
   "latex-workshop.latex.autoBuild.run": "never"
   ```
   The shared `latexmk -pvc` handles all compilation.
5. Host starts **Live Share** — everyone joins for real-time editing.
6. Everyone opens the built-in PDF viewer (`Ctrl+Alt+V` → "View LaTeX PDF")
   — **SyncTeX works for all**:
   - Forward search: `Ctrl+Alt+J`
   - Backward search: `Ctrl+Click` on PDF

### Why shared latexmk?

Without it, everyone's VS Code would trigger a separate `latexmk` on every save,
causing file-lock conflicts and corrupt auxiliary files.  A single `-pvc` watcher
avoids this entirely.

### Port sharing

No ports to share — everyone accesses the PDF through Remote-SSH directly.

---

## TeXlyre — AI-Powered Web Editor

A local Overleaf-like service with ChatGPT integration, based on [TeXlyre](https://github.com/texlyre/texlyre).

### Features
- **In-browser LaTeX/Typst compilation** (WASM, no server-side TeX Live needed)
- **Real-time collaboration** via WebRTC (peer-to-peer, no server needed)
- **AI Assistant** — chat with OpenAI-compatible APIs directly in the editor
- **Local-first** — all data stored in IndexedDB, works offline
- **SyncTeX** support for source-PDF navigation

### Quick Start

```bash
cd texlyre
cp .env.example .env   # edit with your OpenAI API key
npm install
npm run dev            # http://localhost:4173
```

### AI Assistant

The built-in AI panel uses the **Secrets API** to store your API key (encrypted in localStorage). Click the ⚙ button to configure:

| Setting | Description |
|---------|-------------|
| API Key | OpenAI API key (or any compatible provider) |
| API Base URL | Default: `https://api.openai.com/v1` — change for local LLMs |
| Model | Default: `gpt-4o-mini` |

Toggle **"Include document context"** to send the current LaTeX source as context for the AI.

---

## Multi-Project Management

Use `scripts/manager.sh` to manage multiple LaTeX projects simultaneously under a
common base directory (e.g. `~/Projects`).

```bash
# Status of all projects under ~/Projects
bash scripts/manager.sh ~/Projects status

# Start all projects (auto-assigns ports 8761, 8762, …)
bash scripts/manager.sh ~/Projects start

# Start a single project
bash scripts/manager.sh ~/Projects start proj_1

# Stop all / stop one
bash scripts/manager.sh ~/Projects stop
bash scripts/manager.sh ~/Projects stop proj_2

# Attach to the shared tmux session to see all terminals
tmux attach -t ltc
```

**How it works:**
- Scans `~/Projects/*/main.tex` to discover projects
- Each project runs in a **tmux window** (one window = one project)
  - Pane 0: `latexmk -pvc`
  - Pane 1: `httpserver.py` on a **unique port** (base 8761, +1 per project)
- Customise a project's port by creating a `.ltc` file in its root:
  ```bash
  echo "PORT=8888" > ~/Projects/proj_1/.ltc
  ```
- The `<project>` argument matches the **folder name**, so `proj_1` matches
  `~/Projects/proj_1`.

**Live Share with multiple projects:** Share each port individually via
"Live Share: Share Ports" (add 8761, 8762, …).  Guests access each project's PDF
at `http://localhost:8761/`, `http://localhost:8762/`, etc.

---

## Best Practice: Live Share Port Sharing

**Pain point:** Live Share ports are **not persistent** — they are shared only for the duration of a Live Share session. When the Host ends the session, the port sharing stops.

**Workflow for repeat sessions:**

1. Host starts the Live Share session
2. Host re-shares port 8766 (Command Palette → "Live Share: Share Ports")
3. Done

There is **no way** to make port sharing fully automatic across Live Share sessions, but the overhead is minimal — it's two clicks after starting the session.

**Tip:** Keep the HTTP server and latexmk running in the background (even without an active Live Share session). Then when guests rejoin, only step 2 (share port) is needed.
