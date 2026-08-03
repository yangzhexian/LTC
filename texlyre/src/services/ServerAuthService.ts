// src/services/ServerAuthService.ts
// Tier 1: server-side accounts + sessions + project ACL.
// The session token obtained here is what browsers present on ALL server
// WebSocket connections (yjs sync + terminal) — it is never baked into the
// bundle, so strangers who know the IP cannot bypass it via devtools.

const SESSION_KEY = 'texlyre-server-session';

// Base URL of the yjs-ws-server, derived from the collab WebSocket setting
// (ws://host:8082 → http://host:8082), falling back to port 8082 on the
// current host. All account/ACL API calls go here.
export function getServerApiBaseUrl(): string {
	try {
		const stored = localStorage.getItem('texlyre-settings');
		const ws = stored ? JSON.parse(stored)['collab-websocket-server'] : '';
		if (typeof ws === 'string' && ws) {
			return ws.replace(/^ws:\/\//, 'http://').replace(/\/+$/, '');
		}
	} catch {}
	return `http://${window.location.hostname}:8082`;
}

export interface ServerSession {
	token: string;
	username: string;
}

export function getServerSession(): ServerSession | null {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		const session = JSON.parse(raw) as ServerSession;
		if (!session?.token || !session?.username) return null;
		return session;
	} catch {
		return null;
	}
}

export function setServerSession(session: ServerSession): void {
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearServerSession(): void {
	localStorage.removeItem(SESSION_KEY);
}

async function api<T>(
	path: string,
	options?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 8000);
	try {
		const res = await fetch(`${getServerApiBaseUrl()}${path}`, {
			method: options?.method ?? 'GET',
			headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
			body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: controller.signal,
		});
		return (await res.json().catch(() => ({}))) as T;
	} finally {
		clearTimeout(timer);
	}
}

export interface AuthResult {
	ok: boolean;
	token?: string;
	user?: { username: string };
	error?: string;
}

export async function login(username: string, password: string): Promise<AuthResult> {
	return api<AuthResult>('/api/login', {
		method: 'POST',
		body: { username, password },
	});
}

export async function register(
	username: string,
	password: string,
	inviteCode?: string,
): Promise<AuthResult> {
	return api<AuthResult>('/api/register', {
		method: 'POST',
		body: { username, password, inviteCode },
	});
}

export async function logout(): Promise<void> {
	const session = getServerSession();
	if (!session) return;
	await api('/api/logout', { method: 'POST', body: { token: session.token } }).catch(
		() => {},
	);
	clearServerSession();
}

// Validate the stored session against the server (used on app load).
export async function me(): Promise<ServerSession | null> {
	const session = getServerSession();
	if (!session) return null;
	const result = await api<{ ok: boolean; user?: { username: string } }>(
		`/api/me?token=${encodeURIComponent(session.token)}`,
	);
	if (result?.ok && result.user?.username === session.username) {
		return session;
	}
	clearServerSession();
	return null;
}

// ---- project ACL ----
export async function registerProject(
	projectId: string,
	name?: string,
): Promise<void> {
	const session = getServerSession();
	if (!session) return;
	await api('/api/projects', {
		method: 'POST',
		body: { token: session.token, id: projectId, name },
	}).catch(() => {});
}

export async function shareProject(
	projectId: string,
	username: string,
): Promise<{ ok: boolean; error?: string }> {
	const session = getServerSession();
	if (!session) return { ok: false, error: 'not signed in' };
	return api('/api/projects/share', {
		method: 'POST',
		body: { token: session.token, id: projectId, username },
	});
}

export async function unshareProject(
	projectId: string,
	username: string,
): Promise<{ ok: boolean; error?: string }> {
	const session = getServerSession();
	if (!session) return { ok: false, error: 'not signed in' };
	return api('/api/projects/unshare', {
		method: 'POST',
		body: { token: session.token, id: projectId, username },
	});
}

export async function listProjects(): Promise<
	Array<{ id: string; name: string; owner: string }>
> {
	const session = getServerSession();
	if (!session) return [];
	const result = await api<{ ok: boolean; projects: Array<{ id: string; name: string; owner: string }> }>(
		`/api/projects?token=${encodeURIComponent(session.token)}`,
	);
	return result?.projects ?? [];
}

export interface ProjectMembers {
	id: string;
	name: string;
	owner: string;
	members: string[];
}

export async function getProjectMembers(
	projectId: string,
): Promise<{ ok: boolean; project?: ProjectMembers; error?: string }> {
	const session = getServerSession();
	if (!session) return { ok: false, error: 'not signed in' };
	return api(`/api/projects/members?token=${encodeURIComponent(session.token)}&id=${encodeURIComponent(projectId)}`);
}

// ---- session heartbeat ----
// Keeps the server session alive while the app is open (each me() call also
// triggers the server's sliding expiry) and detects when the session was
// invalidated elsewhere (e.g. admin revoked it) or expired: on 401 the app
// clears the session and reloads so the login screen appears instead of
// silently failing WebSocket reconnects.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionHeartbeat(intervalMs = 60_000): void {
	if (heartbeatTimer) return;
	if (!getServerSession()) return;
	heartbeatTimer = setInterval(async () => {
		if (document.visibilityState === 'hidden') return; // skip in background tabs
		const hadSession = !!getServerSession();
		if (!hadSession) return;
		const session = await me().catch(() => null);
		if (!session && hadSession) {
			clearServerSession();
			window.location.reload();
		}
	}, intervalMs);
}
