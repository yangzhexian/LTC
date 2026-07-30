// src/components/ai/TerminalPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalPanelProps {
  className?: string;
  wsUrl?: string;
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({
  className = '',
  wsUrl,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const initialized = useRef(false);

  const effectiveWsUrl =
    wsUrl || `ws://${window.location.hostname}:8084`;

  useEffect(() => {
    if (isCollapsed || initialized.current) return;
    initialized.current = true;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
      },
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
      term.write('\x1b[32m✓ Connected to server\x1b[0m\r\n');
      term.write(`Working directory: ${window.location.pathname}\r\n`);
      term.write('\r\n');
      term.focus();
    };

    ws.onmessage = (event) => {
      term.write(typeof event.data === 'string' ? event.data : '');
    };

    ws.onclose = () => {
      setIsConnected(false);
      term.write('\r\n\x1b[31m✗ Disconnected\x1b[0m\r\n');
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31m✗ Connection error\x1b[0m\r\n');
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
  }, [isCollapsed, effectiveWsUrl]);

  // Fit when expanded
  useEffect(() => {
    if (!isCollapsed && fitRef.current) {
      setTimeout(() => {
        try { fitRef.current?.fit(); } catch {}
      }, 100);
    }
  }, [isCollapsed]);

  return (
    <div className={`terminal-panel ${isCollapsed ? 'collapsed' : 'expanded'} ${className}`}>
      <div className='terminal-panel-header' onClick={() => setIsCollapsed(!isCollapsed)}>
        <span className='terminal-panel-title'>
          Terminal
          <span className={`terminal-status ${isConnected ? 'connected' : 'disconnected'}`} />
        </span>
        <div className='terminal-panel-controls'>
          <span className='terminal-ws-url'>{effectiveWsUrl}</span>
          <button className='collapse-toggle'>
            {isCollapsed ? '\u25B2' : '\u25BC'}
          </button>
        </div>
      </div>
      {!isCollapsed && (
        <div className='terminal-container' ref={containerRef} />
      )}
    </div>
  );
};

export default TerminalPanel;
