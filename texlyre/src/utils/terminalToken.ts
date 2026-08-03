// src/utils/terminalToken.ts
// Shared auth token (Tier 0) for the terminal server (ws://...:8084 / local
// agent :8085) and the Yjs WebSocket server (ws://...:8082).
// The token is injected at build time by server/start.sh into
// userdata.json (setting "terminal-token") and merged into localStorage
// settings on version change (see main.tsx initUserData).
//
// NOTE: this is a shared secret distributed with the web app — it protects
// against port scanners / strangers who know the server IP, NOT against
// legitimate users of the app. Tier 1 (server-side accounts) is the real fix.

const TOKEN_PLACEHOLDER = '__TERMINAL_TOKEN__';

export function getTerminalToken(): string {
  try {
    const currentUserId = localStorage.getItem('texlyre-current-user');
    const userKey = currentUserId
      ? `texlyre-user-${currentUserId}-settings`
      : '';
    const candidates = userKey ? [userKey, 'texlyre-settings'] : ['texlyre-settings'];
    for (const key of candidates) {
      const stored = localStorage.getItem(key);
      if (!stored) continue;
      const parsed = JSON.parse(stored);
      const value = parsed['terminal-token'];
      if (typeof value === 'string' && value && value !== TOKEN_PLACEHOLDER) {
        return value;
      }
    }
  } catch {}
  return '';
}
