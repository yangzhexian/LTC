// src/components/ServerAuthGate.tsx
// Tier 1 login/register screen — shown after the site access gate. Server
// accounts are required to use collaboration/terminal features; without one
// the app still opens in local-only mode via "use locally".
import { useRef, useState } from 'react';
import '../styles/components/site-access-gate.css';
import {
	login,
	register,
	setServerSession,
} from '../services/ServerAuthService';

interface ServerAuthGateProps {
	onAuthed: () => void;
	onSkip: () => void;
}

type Mode = 'login' | 'register';

const ServerAuthGate: React.FC<ServerAuthGateProps> = ({ onAuthed, onSkip }) => {
	const [mode, setMode] = useState<Mode>('login');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [inviteCode, setInviteCode] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

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
					onAuthed();
					return;
				}
				setError(result.error || 'Login failed');
			} else {
				const result = await register(username.trim(), password, inviteCode.trim());
				if (result.ok && result.token) {
					setServerSession({ token: result.token, username: result.user!.username });
					onAuthed();
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
		<div className='site-access-gate'>
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
