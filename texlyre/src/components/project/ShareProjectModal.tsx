// src/components/project/ShareProjectModal.tsx
import QRCode from 'qrcode';
import type React from 'react';
import { useEffect, useState } from 'react';

import { t } from '@/i18n';
import { ShareIcon } from '../common/Icons';
import CopyField from '../common/CopyField';
import Modal from '../common/Modal';
import {
	getProjectMembers,
	getServerSession,
	shareProject,
	unshareProject,
	type ProjectMembers,
} from '../../services/ServerAuthService';

interface ShareProjectModalProps {
	isOpen: boolean;
	onClose: () => void;
	projectName: string;
	shareUrl: string;
	projectId: string;
}

const ShareProjectModal: React.FC<ShareProjectModalProps> = ({
	isOpen,
	onClose,
	projectName,
	shareUrl,
	projectId,
}) => {
	const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
	const [members, setMembers] = useState<ProjectMembers | null>(null);
	const [inviteUsername, setInviteUsername] = useState('');
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
	const [error, setError] = useState('');

	const session = getServerSession();
	const currentUsername = session?.username || '';
	const isOwner = !!members && members.owner === currentUsername;

	const loadMembers = async () => {
		if (!projectId) return;
		setError('');
		const result = await getProjectMembers(projectId);
		if (result.ok && result.project) {
			setMembers(result.project);
		} else {
			setMembers(null);
			setError(result.error || 'Failed to load members');
		}
	};

	useEffect(() => {
		if (isOpen && shareUrl) {
			QRCode.toDataURL(shareUrl, {
				width: 200,
				margin: 2,
				color: {
					dark: '#000000',
					light: '#ffffff',
				},
			})
				.then(setQrCodeUrl)
				.catch(console.error);
		}
		if (isOpen && getServerSession()) {
			void loadMembers();
		}
	}, [isOpen, shareUrl, projectId]);

	const handleInvite = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy || !inviteUsername.trim() || !projectId) return;
		setBusy(true);
		setMessage('');
		setError('');
		const result = await shareProject(projectId, inviteUsername.trim());
		setBusy(false);
		if (result.ok) {
			setMessage(`${inviteUsername.trim()} added`);
			setInviteUsername('');
			void loadMembers();
		} else {
			setError(result.error || 'Invite failed');
		}
	};

	const handleRemove = async (username: string) => {
		if (busy || !projectId) return;
		setBusy(true);
		setMessage('');
		setError('');
		const result = await unshareProject(projectId, username);
		setBusy(false);
		if (result.ok) {
			setMessage(`${username} removed`);
			void loadMembers();
		} else {
			setError(result.error || 'Remove failed');
		}
	};

	return (
		<Modal
			isOpen={isOpen}
			onClose={onClose}
			title={t('Share Project')}
			icon={ShareIcon}
			size='medium'
		>
			<div className='share-project-content'>
				<div className='share-info'>
					<h4>
						{t('Share "')}
						{projectName}"
					</h4>
					<p>
						{t(
							'Collaborators need this link AND a server account added to the project below.',
						)}
					</p>
				</div>

				<div className='share-url-section'>
					<CopyField
						id='share-url'
						label={t('Project Link')}
						value={shareUrl}
					/>
				</div>

				{qrCodeUrl && (
					<div className='qr-code-section'>
						<label>{t('QR Code')}</label>
						<div className='qr-code-container'>
							<img src={qrCodeUrl} alt={t('QR Code for project link')} />
							<p>{t('Scan to open project on mobile')}</p>
						</div>
					</div>
				)}

				{getServerSession() && (
					<div className='share-members-section'>
						<label>{t('Collaborators (server accounts)')}</label>

						{members ? (
							<ul className='share-members-list'>
								{members.members.map((username) => (
									<li key={username} className='share-member-item'>
										<span className='share-member-name'>
											{username}
											{username === members.owner && (
												<span className='share-member-owner'>{t('Owner')}</span>
											)}
										</span>
										{isOwner && username !== members.owner && (
											<button
												className='share-member-remove'
												type='button'
												disabled={busy}
												onClick={() => void handleRemove(username)}
											>
												{t('Remove')}
											</button>
										)}
									</li>
								))}
							</ul>
						) : (
							<p className='share-members-loading'>{t('Loading members...')}</p>
						)}

						{isOwner && (
							<form className='share-invite-form' onSubmit={handleInvite}>
								<input
									className='share-invite-input'
									type='text'
									value={inviteUsername}
									onChange={(e) => setInviteUsername(e.target.value)}
									placeholder={t('Username to invite')}
									disabled={busy}
								/>
								<button
									className='share-invite-button'
									type='submit'
									disabled={busy || !inviteUsername.trim()}
								>
									{t('Invite')}
								</button>
							</form>
						)}

						{message && <p className='share-message success'>{message}</p>}
						{error && <p className='share-message error'>{error}</p>}
					</div>
				)}

				<div className='info-message'>
					<h5>{t('Sharing Tips')}</h5>
					<ul>
						<li>
							{t(
								'The project owner invites collaborators by their server username',
							)}
						</li>
						<li>
							{t(
								'Invited users open the link and sign in to start collaborating',
							)}
						</li>
						<li>
							{t(
								'Only the owner and invited members can access the project',
							)}
						</li>
					</ul>
				</div>
			</div>
		</Modal>
	);
};

export default ShareProjectModal;
