# Local LaTeX Collaboration (LTC)

A zero-friction setup for real-time collaborative LaTeX editing on a remote server.

**How it works:**

```
Remote Linux Server (TeX Live)
├── latexmk — auto-compiles .tex on save
├── scripts/httpserver.py — serves ONLY the PDF on port 8766 (auto-refresh)
└── VS Code Live Share — shares the port to Guests

Guests → VS Code + Live Share → edit .tex files → browser auto-refreshes PDF
```

---

## Prerequisites (Host)

| Requirement | Notes |
|-------------|-------|
| Remote Linux server | TeX Live + python3 installed |
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
├── scripts/
│   ├── httpserver.py     # Custom PDF-only HTTP server (auto-refresh)
│   └── start.sh          # CLI one-click launcher (tmux-based)
├── .vscode/
│   ├── settings.json     # LaTeX Workshop config (auto-build on save, no PDF viewer)
│   ├── tasks.json        # VS Code Task: "Start All Services"
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

## Best Practice: Live Share Port Sharing

**Pain point:** Live Share ports are **not persistent** — they are shared only for the duration of a Live Share session. When the Host ends the session, the port sharing stops.

**Workflow for repeat sessions:**

1. Host starts the Live Share session
2. Host re-shares port 8766 (Command Palette → "Live Share: Share Ports")
3. Done

There is **no way** to make port sharing fully automatic across Live Share sessions, but the overhead is minimal — it's two clicks after starting the session.

**Tip:** Keep the HTTP server and latexmk running in the background (even without an active Live Share session). Then when guests rejoin, only step 2 (share port) is needed.
