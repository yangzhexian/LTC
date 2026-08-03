// src/components/SiteAccessGate.tsx
// Full-screen entry gate: the web app is locked until the visitor enters the
// site access token (configured at server startup). Prevents strangers who
// only know the server IP from opening/registering on the app.
import { useEffect, useRef, useState } from 'react';
import '../styles/components/site-access-gate.css';

export type SiteAccessResult = 'granted' | 'denied' | 'unreachable';

// Base URL of the yjs-ws-server, derived from the collab WebSocket setting
// (ws://host:8082 → http://host:8082), falling back to port 8082 on the
// current host. The server verifies the token at /api/site-access.
export function getSiteAccessBaseUrl(): string {
	try {
		const stored = localStorage.getItem('texlyre-settings');
		const ws = stored ? JSON.parse(stored)['collab-websocket-server'] : '';
		if (typeof ws === 'string' && ws) {
			return ws.replace(/^ws:\/\//, 'http://').replace(/\/+$/, '');
		}
	} catch {}
	return `http://${window.location.hostname}:8082`;
}

export async function checkSiteAccess(
	token: string,
	timeoutMs = 5000,
): Promise<SiteAccessResult> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const url = `${getSiteAccessBaseUrl()}/api/site-access?token=${encodeURIComponent(token)}`;
		const res = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (res.ok) {
			const body = await res.json().catch(() => ({}));
			return body?.ok === false ? 'denied' : 'granted';
		}
		return 'denied';
	} catch {
		return 'unreachable';
	}
}

export function isSiteAccessVerified(): boolean {
	return localStorage.getItem('texlyre-site-access-verified') === '1';
}

interface SiteAccessGateProps {
	initialStatus?: SiteAccessResult;
	onUnlocked: () => void;
}

const SiteAccessGate: React.FC<SiteAccessGateProps> = ({
	initialStatus = 'unreachable',
	onUnlocked,
}) => {
	const [status, setStatus] = useState<SiteAccessResult>(initialStatus);
	const [token, setToken] = useState('');
	const [checking, setChecking] = useState(false);
	const [hasAttempted, setHasAttempted] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Gate disabled on the server (empty token) → enter immediately
	useEffect(() => {
		if (status === 'granted') {
			onUnlocked();
			return;
		}
		if (status === 'denied') {
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [status, onUnlocked]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (checking) return;
		setChecking(true);
		const result = await checkSiteAccess(token.trim());
		setChecking(false);
		if (result === 'granted') {
			localStorage.setItem('texlyre-site-access-verified', '1');
			setStatus('granted');
		} else {
			setHasAttempted(true);
			setStatus(result);
			setToken('');
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	};

	return (
		<div className='site-access-gate'>
			<div className='site-access-card'>
				<h1 className='site-access-title'>LTC</h1>
				<p className='site-access-subtitle'>
					This workspace is protected. Enter the site access token to continue.
				</p>

				<form onSubmit={handleSubmit}>
					<input
						ref={inputRef}
						className='site-access-input'
						type='password'
						value={token}
						onChange={(e) => setToken(e.target.value)}
						placeholder='Site access token'
						autoFocus
						disabled={checking}
					/>
					<button
						className='site-access-button'
						type='submit'
						disabled={checking || !token.trim()}
					>
						{checking ? 'Verifying...' : 'Enter'}
					</button>
				</form>

				{hasAttempted && status === 'denied' && (
					<p className='site-access-error'>
						Wrong token. Please check with the server administrator.
					</p>
				)}
				{status === 'unreachable' && (
					<p className='site-access-error'>
						Cannot reach the collaboration server. Is the server running?
					</p>
				)}
			</div>
		</div>
	);
};

export default SiteAccessGate;
