// src/components/ai/TerminalPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { fontSizeMap } from '../../contexts/EditorContext';
import { useSettings } from '../../hooks/useSettings';
import { useTheme } from '../../hooks/useTheme';

interface TerminalPanelProps {
  className?: string;
  wsUrl?: string;
  projectId?: string | null;
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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const initialized = useRef(false);
  const [isConnected, setIsConnected] = useState(false);

  const { getSetting } = useSettings();
  const { isCurrentVariantDark } = useTheme();

  // Working directory: ~/Projects/<projectId> — resolved server-side against $HOME
  const cwd = projectId ? `Projects/${projectId}` : '';

  const effectiveWsUrl = (() => {
    const base = wsUrl || `ws://${window.location.hostname}:8084`;
    if (!cwd) return base;
    return `${base}?cwd=${encodeURIComponent(cwd)}`;
  })();

  const fontSetting = (getSetting('editor-font-size')?.value as string) || 'base';
  const fontSize = parseInt(fontSizeMap[fontSetting as keyof typeof fontSizeMap] || '14px', 10) || 14;

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

    const ws = new WebSocket(effectiveWsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      term.clear();
      if (cwd) {
        term.write(`\x1b[90mWorking in: ~/${cwd}\x1b[0m\r\n`);
      }
      term.focus();
    };

    ws.onmessage = (event) => {
      term.write(typeof event.data === 'string' ? event.data : '');
    };

    ws.onclose = () => {
      setIsConnected(false);
      term.write('\r\n\x1b[31mDisconnected — reconnecting...\x1b[0m\r\n');
      // Auto-reconnect after 2s
      setTimeout(() => {
        if (termRef.current && !wsRef.current?.OPEN) {
          window.location.reload();
        }
      }, 2000);
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31mConnection error\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const onResize = () => {
      try { fit.fit(); } catch {}
      if (ws.readyState === WebSocket.OPEN) {
        const dims = fit.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      }
    };

    window.addEventListener('resize', onResize);
    const resizeObserver = new ResizeObserver(() => onResize());
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
      initialized.current = false;
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
          Terminal
          <span className={`terminal-status ${isConnected ? 'connected' : 'disconnected'}`} />
        </span>
        <span className='terminal-cwd'>{cwd ? `~/${cwd}` : ''}</span>
      </div>
      <div className='terminal-container' ref={containerRef} />
    </div>
  );
};

export default TerminalPanel;
