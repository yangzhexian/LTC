// src/components/ServerAuthGate.tsx
// Tier 1 login/register screen — the only entry to the app. Server accounts
// are required to use collaboration/terminal features; without one the app
// still opens in local-only mode via "use locally". A light/dark toggle is
// shown and persisted via the same "theme-variant" setting the app reads.
import { useRef, useState } from 'react';
import '../styles/components/site-access-gate.css';
import {
	login,
	register,
	setServerSession,
} from '../services/ServerAuthService';

interface ServerAuthGateProps {
	onAuthed: (username: string) => void;
	onSkip: () => void;
}

type Mode = 'login' | 'register';
type ThemeVariant = 'light' | 'dark';

// Read the app's theme-variant setting (user-scoped key first, then global).
function getStoredTheme(): ThemeVariant {
	try {
		const keys = ['texlyre-settings'];
		const userId = localStorage.getItem('texlyre-current-user');
		if (userId) keys.unshift(`texlyre-user-${userId}-settings`);
		for (const key of keys) {
			const parsed = JSON.parse(localStorage.getItem(key) || '{}');
			if (parsed['theme-variant'] === 'dark' || parsed['theme-variant'] === 'light') {
				return parsed['theme-variant'];
			}
		}
	} catch {}
	return 'light';
}

// Persist to every settings key so the app picks the same theme after login.
function setStoredTheme(variant: ThemeVariant): void {
	try {
		const keys = ['texlyre-settings'];
		const userId = localStorage.getItem('texlyre-current-user');
		if (userId) keys.unshift(`texlyre-user-${userId}-settings`);
		for (const key of keys) {
			const parsed = JSON.parse(localStorage.getItem(key) || '{}');
			parsed['theme-variant'] = variant;
			localStorage.setItem(key, JSON.stringify(parsed));
		}
	} catch {}
}

const SunIcon = () => (
	<svg viewBox='0 0 24 24' aria-hidden='true'>
		<path d='M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 3v2m0-20v2m8.5 8.5H22m-20 0h2m14.1-6.1 1.4-1.4m-16.9 0 1.4 1.4m11.3 11.3 1.4 1.4m-16.9 0 1.4-1.4' stroke='currentColor' strokeWidth='2' fill='none' strokeLinecap='round' />
	</svg>
);

const MoonIcon = () => (
	<svg viewBox='0 0 24 24' aria-hidden='true'>
		<path d='M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' stroke='currentColor' strokeWidth='2' fill='none' strokeLinejoin='round' />
	</svg>
);

const ServerAuthGate: React.FC<ServerAuthGateProps> = ({ onAuthed, onSkip }) => {
	const [mode, setMode] = useState<Mode>('login');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [inviteCode, setInviteCode] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [isDark, setIsDark] = useState<boolean>(() => getStoredTheme() === 'dark');
	const inputRef = useRef<HTMLInputElement>(null);

	const toggleTheme = () => {
		const next = !isDark;
		setIsDark(next);
		setStoredTheme(next ? 'dark' : 'light');
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setError('');
		try {
			if (mode === 'login') {
				const result = await login(username.trim(), password);
				if (result.ok && result.token) {
					setServerSession({ token: result.token, username: result.user!.username });
					onAuthed(result.user!.username);
					return;
				}
				setError(result.error || 'Login failed');
			} else {
				const result = await register(username.trim(), password, inviteCode.trim());
				if (result.ok && result.token) {
					setServerSession({ token: result.token, username: result.user!.username });
					onAuthed(result.user!.username);
					return;
				}
				setError(result.error || 'Registration failed');
			}
		} catch {
			setError('Cannot reach the server. Is it running?');
		}
		setBusy(false);
		setTimeout(() => inputRef.current?.focus(), 30);
	};

	return (
		<div className={`site-access-gate ${isDark ? '' : 'light'}`}>
			<button
				className='site-access-theme-toggle'
				type='button'
				onClick={toggleTheme}
				title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
			>
				{isDark ? <SunIcon /> : <MoonIcon />}
				{isDark ? 'Light' : 'Dark'}
			</button>
			<div className='site-access-card'>
				<h1 className='site-access-title'>LTC</h1>
				<p className='site-access-subtitle'>
					{mode === 'login'
						? 'Sign in with your server account to collaborate.'
						: 'Create a server account (ask the admin for the invite code).'}
				</p>

				<form onSubmit={handleSubmit}>
					<input
						ref={inputRef}
						className='site-access-input'
						type='text'
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						placeholder='Username'
						autoComplete='username'
						autoFocus
						disabled={busy}
					/>
					<input
						className='site-access-input'
						type='password'
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder='Password (min 8 chars)'
						autoComplete='current-password'
						disabled={busy}
					/>
					{mode === 'register' && (
						<input
							className='site-access-input'
							type='text'
							value={inviteCode}
							onChange={(e) => setInviteCode(e.target.value)}
							placeholder='Invite code (if required)'
							disabled={busy}
						/>
					)}
					<button
						className='site-access-button'
						type='submit'
						disabled={busy || !username.trim() || !password}
					>
						{busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account'}
					</button>
				</form>

				<div className='site-access-switch'>
					<button
						className='site-access-link'
						type='button'
						onClick={() => {
							setMode(mode === 'login' ? 'register' : 'login');
							setError('');
						}}
					>
						{mode === 'login'
							? 'Need an account? Register'
							: 'Already have an account? Sign in'}
					</button>
				</div>

				{error && <p className='site-access-error'>{error}</p>}

				<div className='site-access-skip'>
					<button className='site-access-link' type='button' onClick={onSkip}>
						Use locally without server access
					</button>
				</div>
			</div>
		</div>
	);
};

export default ServerAuthGate;
