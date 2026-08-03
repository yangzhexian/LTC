// src/components/project/ShareProjectModal.tsx
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import { t } from '@/i18n';
import { ShareIcon } from '../common/Icons';
import CopyField from '../common/CopyField';
import Modal from '../common/Modal';
import {
	getProjectMembers,
	getServerSession,
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
	const [error, setError] = useState('');

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
							'Anyone with this link becomes a collaborator automatically after signing in.',
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
						<label>{t('Collaborators')}</label>

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
									</li>
								))}
							</ul>
						) : (
							<p className='share-members-loading'>{t('Loading members...')}</p>
						)}

						{error && <p className='share-message error'>{error}</p>}
					</div>
				)}

				<div className='info-message'>
					<h5>{t('Sharing Tips')}</h5>
					<ul>
						<li>
							{t(
								'Send the link to anyone — they sign in and join automatically',
							)}
						</li>
						<li>
							{t(
								'Anyone who opened the link can edit documents and files in real-time',
							)}
						</li>
					</ul>
				</div>
			</div>
		</Modal>
	);
};

export default ShareProjectModal;

