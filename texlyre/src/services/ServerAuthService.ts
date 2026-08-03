// src/services/ServerAuthService.ts
// Tier 1: server-side accounts + sessions + project ACL.
// The session token obtained here is what browsers present on ALL server
// WebSocket connections (yjs sync + terminal) — it is never baked into the
// bundle, so strangers who know the IP cannot bypass it via devtools.
import { getSiteAccessBaseUrl } from '../components/SiteAccessGate';

const SESSION_KEY = 'texlyre-server-session';

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
		const res = await fetch(`${getSiteAccessBaseUrl()}${path}`, {
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
