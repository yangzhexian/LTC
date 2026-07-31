// src/components/ai/TerminalPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { fontSizeMap } from '../../contexts/EditorContext';
import { useSettings } from '../../hooks/useSettings';
import { useTheme } from '../../hooks/useTheme';
import { fileStorageEventEmitter, fileStorageService } from '../../services/FileStorageService';
import { isTemporaryFile } from '../../utils/fileUtils';

interface TerminalPanelProps {
  className?: string;
  wsUrl?: string;
  projectId?: string | null;
  documents?: Array<{ id: string; name: string }>;
  docUrl?: string;
}

const DARK_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b70',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#2563eb',
  cursorAccent: '#ffffff',
  selectionBackground: '#c7d5f5',
  black: '#4a5568',
  red: '#c53030',
  green: '#2f855a',
  yellow: '#b7791f',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0e7490',
  white: '#64748b',
  brightBlack: '#94a3b8',
  brightRed: '#c53030',
  brightGreen: '#2f855a',
  brightYellow: '#b7791f',
  brightBlue: '#2563eb',
  brightMagenta: '#9333ea',
  brightCyan: '#0e7490',
  brightWhite: '#1f2328',
};

const TerminalPanel: React.FC<TerminalPanelProps> = ({
  className = '',
  wsUrl,
  projectId,
  documents,
  docUrl,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const initialized = useRef(false);
  const syncStarted = useRef(false);
  const [isConnected, setIsConnected] = useState(false);
  const [syncedFiles, setSyncedFiles] = useState(0);

  const { getSetting } = useSettings();
  const { isCurrentVariantDark } = useTheme();

  // Refs so pushAllFiles always sees the latest documents/docUrl
  // (the effect closure captures stale values on first mount)
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const docUrlRef = useRef(docUrl);
  docUrlRef.current = docUrl;

  // Working directory: ~/Projects/<projectId> — resolved server-side against $HOME
  const cwd = projectId ? `Projects/${projectId}` : '';

  const effectiveWsUrl = (() => {
    const base = wsUrl || `ws://${window.location.hostname}:8084`;
    if (!cwd) return base;
    return `${base}?cwd=${encodeURIComponent(cwd)}`;
  })();

  const fontSetting = (getSetting('editor-font-size')?.value as string) || 'base';
  const fontSize = parseInt(fontSizeMap[fontSetting as keyof typeof fontSizeMap] || '14px', 10) || 14;

  // ---- File sync: upload project files to server ----
  const getDocumentContent = async (projectUrl: string, docId: string): Promise<string> => {
    const projectId2 = projectUrl.startsWith('yjs:') ? projectUrl.slice(4) : projectUrl;
    const dbName = `texlyre-project-${projectId2}`;
    const docCollection = `${dbName}-yjs_${docId}`;
    try {
      const docYDoc = new Y.Doc();
      const docPersistence = new IndexeddbPersistence(docCollection, docYDoc);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 2000);
        docPersistence.once('synced', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      const text = docYDoc.getText('codemirror').toString();
      docPersistence.destroy();
      docYDoc.destroy();
      return text;
    } catch {
      return '';
    }
  };

  const pushAllFiles = async (ws: WebSocket) => {
    if (!projectId) return;
    try {
      const files = await fileStorageService.getAllFiles(true, true, true);
      console.log('[Agent][debug] getAllFiles:', files.length,
        files.map((f) => `${f.name}(type=${f.type},del=${!!f.isDeleted},content=${typeof f.content})`));
      const uploadedPaths = new Set<string>();
      let count = 0;
      for (const file of files) {
        if (file.type !== 'file' || file.isDeleted || isTemporaryFile(file.path)) continue;
        const content = file.content;
        if (typeof content !== 'string') continue;
        ws.send(JSON.stringify({ type: 'write-file', path: file.path, content }));
        uploadedPaths.add(file.path);
        count++;
      }
      // Upload Yjs documents that aren't already represented as files
      const docs = documentsRef.current || [];
      const docUrl = docUrlRef.current;
      console.log('[Agent][debug] documents prop:', docs.length, 'docUrl:', docUrl);
      if (docs.length > 0 && docUrl) {
        for (const doc of docs) {
          const path = doc.name;
          if (uploadedPaths.has(path)) continue;
          const content = await getDocumentContent(docUrl, doc.id);
          console.log(`[Agent][debug] doc "${doc.name}" content len:`, content.length);
          if (!content) continue;
          ws.send(JSON.stringify({ type: 'write-file', path, content }));
          count++;
        }
      }
      setSyncedFiles(count);
      console.log(`[Agent] uploaded ${count} files to server`);
    } catch (e) {
      console.error('[Agent] upload failed', e);
    }
  };

  // ---- File sync: apply server-side changes back to IndexedDB ----
  const applyServerChange = async (relPath: string, content: string) => {
    try {
      const files = await fileStorageService.getAllFiles(true, false, false);
      const target = files.find(
        (f) => f.type === 'file' && f.path === relPath && !f.isDeleted,
      );
      if (!target) return;
      await fileStorageService.updateFileContent(target.id, content);
      fileStorageEventEmitter.emitChange();
      document.dispatchEvent(
        new CustomEvent('texlyre-agent-file-synced', {
          detail: { path: relPath, content, fileId: target.id },
        }),
      );
      console.log(`[Agent] applied server change to: ${relPath}`);
    } catch (e) {
      console.error('[Agent] apply server change failed', e);
    }
  };

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily:
        "ui-monospace, 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Noto Sans Mono', monospace",
      theme: isCurrentVariantDark ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;

    if (containerRef.current) {
      term.open(containerRef.current);
      setTimeout(() => fit.fit(), 50);
    }

    termRef.current = term;

    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(effectiveWsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setIsConnected(true);
        term.write('\x1b[36m[Agent] connected to project directory\x1b[0m\r\n');
        if (cwd) {
          term.write(`\x1b[90mWorking in: ~/${cwd}\x1b[0m\r\n`);
        }
        term.write('\x1b[90mRun agents like: codex\x1b[0m\r\n\r\n');
        term.focus();
        // Upload project files to the server directory (once per mount)
        if (!syncStarted.current) {
          syncStarted.current = true;
          await pushAllFiles(ws);
        }
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        // Terminal output from the pty arrives as raw text; JSON messages are control
        if (event.data.startsWith('{')) {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'file-changed') {
              applyServerChange(msg.path, msg.content);
              return;
            }
          } catch {}
        }
        term.write(event.data);
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (!closed) {
          term.write('\r\n\x1b[31mDisconnected — reconnecting...\x1b[0m\r\n');
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n');
      };

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });
    };

    connect();

    const onResize = () => {
      try { fit.fit(); } catch {}
      if (ws && ws.readyState === WebSocket.OPEN) {
        const dims = fit.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      }
    };

    window.addEventListener('resize', onResize);
    const resizeObserver = new ResizeObserver(() => onResize());
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    // ---- Push browser-side file changes to the server (user edits) ----
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) pushAllFiles(ws);
      }, 1500);
    };
    const unsub = fileStorageEventEmitter.onChange(onChange);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      unsub();
      if (pushTimer) clearTimeout(pushTimer);
      if (ws) ws.close();
      term.dispose();
      initialized.current = false;
      syncStarted.current = false;
    };
  }, [effectiveWsUrl, cwd]);

  // Apply theme changes (light/dark only)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = isCurrentVariantDark ? DARK_THEME : LIGHT_THEME;
  }, [isCurrentVariantDark]);
  // Apply font size changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
  }, [fontSize]);

  // Re-push files when the document list changes (e.g. new document created,
  // or documents finished loading after the terminal connected)
  useEffect(() => {
    if (!documents || documents.length === 0) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      pushAllFiles(ws);
    }
  }, [documents]);

  // Fit when size changes
  useEffect(() => {
    if (!fitRef.current) return;
    setTimeout(() => {
      try { fitRef.current?.fit(); } catch {}
    }, 100);
  }, [isCurrentVariantDark, fontSize]);

  return (
    <div className={`terminal-panel ${className}`}>
      <div className='terminal-panel-header'>
        <span className='terminal-panel-title'>
          Terminal <span className='agent-badge'>Agent</span>
          <span className={`terminal-status ${isConnected ? 'connected' : 'disconnected'}`} />
        </span>
        <span className='terminal-cwd'>
          {cwd ? `~/${cwd}` : ''}
          {syncedFiles > 0 ? ` · ${syncedFiles} files` : ''}
        </span>
      </div>
      <div className='terminal-container' ref={containerRef} />
    </div>
  );
};

export default TerminalPanel;
