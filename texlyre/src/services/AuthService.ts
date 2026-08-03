// src/services/AuthService.ts
import { type IDBPDatabase, openDB } from 'idb';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { t } from '@/i18n';
import type { User } from '../types/auth';
import type { Project, ProjectType, ProjectGroup } from '../types/projects';
import { generateRandomColor } from '../utils/colorUtils';
import { cleanupProjectDatabases } from '../utils/dbDeleteUtils';
import { generateYjsProjectId } from '../utils/urlUtils';
import { fileSystemBackupService } from './FileSystemBackupService';
import { createNamedLogger } from '@/logging';

const moduleLog = createNamedLogger('AuthService');

const shouldAutoSync = (): boolean => {
	return localStorage.getItem('texlyre-auto-sync') === 'true';
};

class AuthService {
	public db: IDBPDatabase | null = null;
	private readonly DB_NAME = 'texlyre-auth';
	private readonly USER_STORE = 'users';
	private readonly PROJECT_STORE = 'projects';
	private readonly DB_VERSION = 1;
	private currentUser: User | null = null;

	async initialize(): Promise<void> {
		try {
			this.db = await openDB(this.DB_NAME, this.DB_VERSION, {
				upgrade: (db, _oldVersion, _newVersion) => {
					if (!db.objectStoreNames.contains(this.USER_STORE)) {
						const userStore = db.createObjectStore(this.USER_STORE, {
							keyPath: 'id',
						});
						userStore.createIndex('username', 'username', { unique: false });
						userStore.createIndex('email', 'email', { unique: false });
						userStore.createIndex('sessionId', 'sessionId', { unique: false });
					}

					if (!db.objectStoreNames.contains(this.PROJECT_STORE)) {
						const projectStore = db.createObjectStore(this.PROJECT_STORE, {
							keyPath: 'id',
						});
						projectStore.createIndex('ownerId', 'ownerId', { unique: false });
						projectStore.createIndex('tags', 'tags', {
							unique: false,
							multiEntry: true,
						});
					}
				},
			});

			const userId = localStorage.getItem('texlyre-current-user');
			if (userId) {
				try {
					const user = await this.getUserById(userId);
					if (user) {
						if (this.isGuestUser(user) && this.isGuestExpired(user)) {
							moduleLog.info(`Guest session expired: ${userId}`);
							await this.cleanupExpiredGuest(user);
							localStorage.removeItem('texlyre-current-user');
						} else {
							this.currentUser = user;
							moduleLog.info(
								`Restored user session: ${user.username} (${this.isGuestUser(user) ? 'guest' : 'full'})`,
							);
						}
					} else {
						moduleLog.info(`User not found: ${userId}`);
						localStorage.removeItem('texlyre-current-user');
					}
				} catch (error) {
					moduleLog.error('Error restoring user session:', error);
					localStorage.removeItem('texlyre-current-user');
				}
			}

			// Run cleanup on initialization
			this.cleanupExpiredGuests();
		} catch (error) {
			moduleLog.error('Failed to initialize database:', error);
			throw error;
		}
	}

	// Pure-JS SHA-256 fallback (works on insecure contexts where crypto.subtle is unavailable)
	private sha256Hex(input: string): string {
		const utf8 = new TextEncoder().encode(input);

		// Initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
		const H = [
			0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
			0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
		];
		// Round constants (first 32 bits of fractional parts of cube roots of first 64 primes)
		const K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
			0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
			0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
			0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
			0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
			0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
		];

		// Padding: append 0x80, zeros, then 64-bit bit length
		const bitLen = utf8.length * 8;
		const padded = new Uint8Array(((utf8.length + 8) >> 6 << 6) + 64);
		padded.set(utf8);
		padded[utf8.length] = 0x80;
		const dv = new DataView(padded.buffer);
		dv.setUint32(padded.length - 4, bitLen >>> 0, false);
		// Note: for messages < 2^32 bits this suffices (padded.length - 8 holds 0)

		const w = new Uint32Array(64);
		for (let i = 0; i < padded.length; i += 64) {
			for (let t = 0; t < 16; t++) {
				w[t] = dv.getUint32(i + t * 4, false);
			}
			for (let t = 16; t < 64; t++) {
				const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
				const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
			}

			let [a, b, c, d, e, f, g, h] = H;
			for (let t = 0; t < 64; t++) {
				const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
				const ch = (e & f) ^ (~e & g);
				const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
				const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
				const maj = (a & b) ^ (a & c) ^ (b & c);
				const temp2 = (S0 + maj) >>> 0;
				h = g; g = f; f = e;
				e = (d + temp1) >>> 0;
				d = c; c = b; b = a;
				a = (temp1 + temp2) >>> 0;
			}
			H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
			H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
			H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
			H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
		}

		return H.map((x) => x.toString(16).padStart(8, '0')).join('');
	}

	async hashPassword(password: string): Promise<string> {
		try {
			if (crypto?.subtle) {
				const msgBuffer = new TextEncoder().encode(password);
				const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
				const hashArray = Array.from(new Uint8Array(hashBuffer));
				return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
			}
		} catch {
			// fall through to pure-JS implementation
		}
		return this.sha256Hex(password);
	}

	generateSessionId(): string {
		return `guest_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
	}

	isGuestUser(user: User | null): boolean {
		return !!user?.isGuest;
	}

	isGuestExpired(user: User | null): boolean {
		if (!user || !this.isGuestUser(user) || !user.expiresAt) return false;
		return Date.now() > user.expiresAt;
	}

	async createGuestAccount(): Promise<User> {
		if (!this.db) {
			moduleLog.info('Database not initialized, initializing...');
			await this.initialize();
		}

		// Clean up any existing expired guests first
		await this.cleanupExpiredGuests();

		const sessionId = this.generateSessionId();
		const userId = `guest_${crypto.randomUUID()}`;
		const now = Date.now();
		const expiresAt = now + 24 * 60 * 60 * 1000;

		const guestUser: User = {
			id: userId,
			username: t('Guest User'),
			passwordHash: await this.hashPassword(sessionId),
			isGuest: true,
			sessionId,
			expiresAt,
			createdAt: now,
			lastLogin: now,
			color: generateRandomColor(false),
			colorLight: generateRandomColor(true),
		};

		try {
			moduleLog.info(`Creating guest user with ID: ${userId}`);
			await this.db?.put(this.USER_STORE, guestUser);

			const verifyUser = await this.db?.get(this.USER_STORE, userId);
			if (!verifyUser) {
				throw new Error(t('Failed to verify guest user creation'));
			}

			this.currentUser = guestUser;
			localStorage.setItem('texlyre-current-user', userId);

			moduleLog.info(`Successfully created guest account: ${sessionId}`);
			return guestUser;
		} catch (error) {
			moduleLog.error('Failed to create guest account:', error);
			throw new Error(
				t(
					'Failed to create guest session. Please refresh the page and try again',
				),
			);
		}
	}

	async upgradeGuestAccount(
		username: string,
		password: string,
		email?: string,
	): Promise<User> {
		if (!this.db) await this.initialize();
		if (!this.currentUser || !this.isGuestUser(this.currentUser)) {
			throw new Error(t('No guest account to upgrade'));
		}

		const existingUser = await this.db?.getFromIndex(
			this.USER_STORE,
			'username',
			username,
		);
		if (existingUser && !this.isGuestUser(existingUser)) {
			throw new Error(t('Username already exists'));
		}

		if (email) {
			const existingEmail = await this.db?.getFromIndex(
				this.USER_STORE,
				'email',
				email,
			);
			if (existingEmail && !this.isGuestUser(existingEmail)) {
				throw new Error(t('Email already exists'));
			}
		}

		const passwordHash = await this.hashPassword(password);
		const now = Date.now();
		const oldGuestId = this.currentUser.id;
		const newUserId = crypto.randomUUID();

		const upgradedUser: User = {
			id: newUserId,
			username,
			email,
			passwordHash,
			createdAt: this.currentUser.createdAt,
			lastLogin: now,
			color: this.currentUser.color,
			colorLight: this.currentUser.colorLight,
			isGuest: undefined,
			sessionId: undefined,
			expiresAt: undefined,
		};

		// Transfer ownership of all guest projects to the new user
		await this.transferGuestProjects(oldGuestId, newUserId);
		await this.db?.put(this.USER_STORE, upgradedUser);
		await this.db?.delete(this.USER_STORE, oldGuestId);

		// Tier 1: register the upgraded user's projects with the server
		// (project ACL) now that they have a server session.
		const { registerProject } = await import('./ServerAuthService');
		const upgradedProjects = await this.getProjectsByUser(newUserId);
		for (const project of upgradedProjects) {
			registerProject(project.id, project.name).catch(() => {});
		}

		this.currentUser = upgradedUser;
		localStorage.setItem('texlyre-current-user', newUserId);

		moduleLog.info(
			`Upgraded guest account ${oldGuestId} to full account: ${username} (${newUserId})`,
		);
		return upgradedUser;
	}

	private async transferGuestProjects(
		oldUserId: string,
		newUserId: string,
	): Promise<void> {
		if (!this.db) return;

		try {
			const guestProjects = await this.getProjectsByUser(oldUserId);

			for (const project of guestProjects) {
				const updatedProject = {
					...project,
					ownerId: newUserId,
					updatedAt: Date.now(),
				};
				await this.db.put(this.PROJECT_STORE, updatedProject);
			}

			moduleLog.info(
				`Transferred ${guestProjects.length} projects from guest ${oldUserId} to user ${newUserId}`,
			);
		} catch (error) {
			moduleLog.error('Error transferring guest projects:', error);
		}
	}

	async cleanupExpiredGuests(): Promise<void> {
		if (!this.db) return;

		try {
			const tx = this.db.transaction(
				[this.USER_STORE, this.PROJECT_STORE],
				'readwrite',
			);
			const userStore = tx.objectStore('users');

			const allUsers = await userStore.getAll();
			const expiredGuests = allUsers.filter(
				(user) => this.isGuestUser(user) && this.isGuestExpired(user),
			);

			for (const expiredGuest of expiredGuests) {
				await this.cleanupExpiredGuest(expiredGuest);
			}

			moduleLog.info(
				`Cleaned up ${expiredGuests.length} expired guest accounts`,
			);
		} catch (error) {
			moduleLog.error('Error during guest cleanup:', error);
		}
	}

	async cleanupExpiredGuest(guestUser: User): Promise<void> {
		if (!this.db) return;

		try {
			moduleLog.info(`Cleaning up guest: ${guestUser.id}`);

			const guestProjects = await this.getProjectsByUser(guestUser.id);
			moduleLog.info(`Found ${guestProjects.length} guest projects to cleanup`);

			for (const project of guestProjects) {
				try {
					await cleanupProjectDatabases(project);
				} catch (error) {
					moduleLog.warn(
						`Failed to cleanup project database for ${project.id}:`,
						error,
					);
				}
			}

			// Remove projects from database
			if (guestProjects.length > 0) {
				const projectTx = this.db.transaction(this.PROJECT_STORE, 'readwrite');
				for (const project of guestProjects) {
					try {
						await projectTx.objectStore('projects').delete(project.id);
					} catch (error) {
						moduleLog.warn(`Failed to delete project ${project.id}:`, error);
					}
				}
			}

			// Remove user from database
			const userTx = this.db.transaction(this.USER_STORE, 'readwrite');
			await userTx.objectStore('users').delete(guestUser.id);

			moduleLog.info(`Successfully cleaned up guest: ${guestUser.id}`);
		} catch (error) {
			moduleLog.error(`Error cleaning up guest ${guestUser.id}:`, error);
		}
	}

	async register(
		username: string,
		password: string,
		email?: string,
	): Promise<User> {
		if (!this.db) await this.initialize();

		// Check for existing non-guest users only
		const existingUser = await this.db?.getFromIndex(
			this.USER_STORE,
			'username',
			username,
		);
		if (existingUser && !this.isGuestUser(existingUser)) {
			throw new Error(t('Username already exists'));
		}

		if (email) {
			const existingEmail = await this.db?.getFromIndex(
				this.USER_STORE,
				'email',
				email,
			);
			if (existingEmail && !this.isGuestUser(existingEmail)) {
				throw new Error(t('Email already exists'));
			}
		}

		const passwordHash = await this.hashPassword(password);
		const userId = crypto.randomUUID();
		const now = Date.now();

		const newUser: User = {
			id: userId,
			username,
			passwordHash,
			email,
			createdAt: now,
			lastLogin: now,
		};

		await this.db?.put(this.USER_STORE, newUser);
		this.currentUser = newUser;
		localStorage.setItem('texlyre-current-user', userId);

		return newUser;
	}

	async login(username: string, password: string): Promise<User> {
		if (!this.db) await this.initialize();

		const user = await this.db?.getFromIndex(
			this.USER_STORE,
			'username',
			username,
		);
		if (!user || this.isGuestUser(user)) {
			throw new Error(t('User not found'));
		}

		const passwordHash = await this.hashPassword(password);
		if (user.passwordHash !== passwordHash) {
			throw new Error(t('Invalid password'));
		}

		user.lastLogin = Date.now();
		await this.db?.put(this.USER_STORE, user);

		this.currentUser = user;
		localStorage.setItem('texlyre-current-user', user.id);

		return user;
	}

	async logout(): Promise<void> {
		if (this.currentUser && this.isGuestUser(this.currentUser)) {
			await this.cleanupExpiredGuest(this.currentUser);
		}

		if (this.currentUser) {
			const { chelysService } = await import('./ChelysService');
			chelysService.logoutChelys(this.currentUser.id);
		}

		this.currentUser = null;
		localStorage.removeItem('texlyre-current-user');
	}

	async updateUser(user: User): Promise<User> {
		if (!this.db) await this.initialize();
		await this.db?.put(this.USER_STORE, user);

		if (this.currentUser && this.currentUser.id === user.id) {
			this.currentUser = user;
		}

		return user;
	}

	async updateUserColor(
		userId: string,
		color?: string,
		colorLight?: string,
	): Promise<User> {
		if (!this.db) await this.initialize();

		const user = await this.getUserById(userId);
		if (!user) {
			throw new Error(t('User not found'));
		}

		const updatedUser: User = {
			...user,
			color,
			colorLight,
		};

		await this.updateUser(updatedUser);
		return updatedUser;
	}

	async getUserById(id: string): Promise<User | null> {
		if (!this.db) await this.initialize();
		return this.db?.get(this.USER_STORE, id);
	}

	async getUserByUsername(username: string): Promise<User | null> {
		if (!this.db) await this.initialize();
		const user = await this.db?.getFromIndex(
			this.USER_STORE,
			'username',
			username,
		);
		return user && !this.isGuestUser(user) ? user : null;
	}

	async setCurrentUser(userId: string): Promise<User | null> {
		const user = await this.getUserById(userId);
		if (user) {
			this.currentUser = user;
			localStorage.setItem('texlyre-current-user', userId);
		}
		return user;
	}

	getCurrentUser(): User | null {
		return this.currentUser;
	}

	isAuthenticated(): boolean {
		return !!this.currentUser;
	}

	async verifyPassword(userId: string, password: string): Promise<boolean> {
		if (!this.db) await this.initialize();

		const user = await this.getUserById(userId);
		if (!user) return false;

		const passwordHash = await this.hashPassword(password);
		return user.passwordHash === passwordHash;
	}

	async updatePassword(userId: string, newPassword: string): Promise<User> {
		if (!this.db) await this.initialize();

		const user = await this.getUserById(userId);
		if (!user) throw new Error(t('User not found'));

		const passwordHash = await this.hashPassword(newPassword);

		const updatedUser = {
			...user,
			passwordHash,
		};

		return this.updateUser(updatedUser);
	}

	private async createNewDocumentUrl(
		projectId: string = generateYjsProjectId(),
		projectName = 'Untitled Project',
		projectDescription = '',
		projectType: ProjectType = 'latex',
		projectGroup: ProjectGroup = 'tex',
	): Promise<string> {
		try {
			const dbName = `texlyre-project-${projectId}`;
			const yjsCollection = `${dbName}-yjs_metadata`;

			const ydoc = new Y.Doc();
			const persistence = new IndexeddbPersistence(yjsCollection, ydoc);

			ydoc.transact(() => {
				const ymap = ydoc.getMap('data');

				ymap.set('documents', []);
				ymap.set('currentDocId', '');
				ymap.set('cursors', []);
				ymap.set('chatMessages', []);
				ymap.set('projectMetadata', {
					name: projectName,
					description: projectDescription,
					type: projectType,
					group: projectGroup,
				});
			});

			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, 2000);
				if (persistence.synced) {
					clearTimeout(timeout);
					resolve();
					return;
				}
				persistence.once('synced', () => {
					clearTimeout(timeout);
					resolve();
				});
			});

			persistence.destroy();
			ydoc.destroy();

			return `yjs:${projectId}`;
		} catch (error) {
			moduleLog.error('Error creating new document:', error);
			throw new Error(t('Failed to create document for project'));
		}
	}

	async createProject(
		project: Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'ownerId'>,
		requireAuth = true,
	): Promise<Project> {
		if (!this.db) await this.initialize();
		if (requireAuth && !this.currentUser) {
			throw new Error('User not authenticated');
		}

		const projectId = project.docUrl
			? project.docUrl.startsWith('yjs:')
				? project.docUrl.slice(4)
				: project.docUrl
			: generateYjsProjectId();

		const docUrl =
			project.docUrl ||
			(await this.createNewDocumentUrl(
				projectId,
				project.name,
				project.description,
				project.type,
				project.group,
			));

		const now = Date.now();
		const newProject: Project = {
			...project,
			docUrl,
			id: projectId,
			createdAt: now,
			updatedAt: now,
			ownerId: this.currentUser.id,
		};

		await this.db?.put(this.PROJECT_STORE, newProject);

		// Tier 1: register the project with the server so the owner becomes a
		// member (project ACL). No-op when not signed in.
		const { registerProject } = await import('./ServerAuthService');
		registerProject(projectId, project.name).catch(() => {});

		if (shouldAutoSync()) {
			fileSystemBackupService.synchronize(newProject.id).catch(console.error);
		}

		return newProject;
	}

	// Tier 1 migration: register ALL local projects with the server (idempotent).
	// Used after signing in so pre-Tier-1 projects created in the browser are
	// accessible again — the signer becomes owner (projects already registered
	// to someone else are skipped server-side). No-op when not signed in.
	async syncProjectsToServer(): Promise<void> {
		try {
			const projects = await this.getProjects();
			if (projects.length === 0) return;
			const { registerProject } = await import('./ServerAuthService');
			await Promise.all(
				projects.map((project) =>
					registerProject(project.id, project.name).catch(() => {}),
				),
			);
		} catch (error) {
			moduleLog.warn('Failed to sync projects to server:', error);
		}
	}

	async updateProject(project: Project): Promise<Project> {
		if (!this.db) await this.initialize();

		const existingProject = await this.db?.get(this.PROJECT_STORE, project.id);
		if (!existingProject) {
			throw new Error(t('Project not found'));
		}

		if (existingProject.ownerId !== this.currentUser?.id) {
			throw new Error(t('You do not have permission to update this project'));
		}

		const updatedProject: Project = {
			...project,
			updatedAt: Date.now(),
		};

		await this.db?.put(this.PROJECT_STORE, updatedProject);

		if (shouldAutoSync() && !this.isGuestUser(this.currentUser)) {
			fileSystemBackupService.synchronize(project.id).catch(console.error);
		}

		return updatedProject;
	}

	async createOrUpdateProject(
		project: Project,
		requireAuth = true,
	): Promise<Project> {
		if (!this.db) await this.initialize();

		if (requireAuth && !this.currentUser) {
			throw new Error(t('User not authenticated'));
		}

		if (project.id) {
			return this.updateProject({
				...project,
				id: project.id,
				ownerId: this.currentUser.id,
			});
		}
		return this.createProject({
			...project,
			docUrl: project.docUrl || (await this.createNewDocumentUrl()),
		});
	}

	async deleteProject(id: string): Promise<void> {
		if (!this.db) await this.initialize();

		const project = await this.db?.get(this.PROJECT_STORE, id);
		if (!project) {
			throw new Error(t('Project not found'));
		}

		if (project.ownerId !== this.currentUser?.id) {
			throw new Error(t('You do not have permission to delete this project'));
		}

		await this.db?.delete(this.PROJECT_STORE, id);
		await cleanupProjectDatabases(project);

		if (shouldAutoSync() && !this.isGuestUser(this.currentUser)) {
			fileSystemBackupService.synchronize().catch(console.error);
		}
	}

	async getProjectById(id: string): Promise<Project | null> {
		if (!this.db) await this.initialize();
		return this.db?.get(this.PROJECT_STORE, id);
	}

	async getProjectsByUser(userId?: string): Promise<Project[]> {
		if (!this.db) await this.initialize();

		const targetUserId = userId || this.currentUser?.id;
		if (!targetUserId) {
			return [];
		}

		const tx = this.db?.transaction(this.PROJECT_STORE, 'readonly');
		const index = tx.store.index('ownerId');
		return index.getAll(targetUserId);
	}

	async getProjects(): Promise<Project[]> {
		return this.getProjectsByUser();
	}

	async getProjectsByTag(tag: string): Promise<Project[]> {
		if (!this.db) await this.initialize();

		if (!this.currentUser) {
			return [];
		}

		const tx = this.db?.transaction(this.PROJECT_STORE, 'readonly');
		const index = tx.store.index('tags');
		const projects = await index.getAll(tag);

		return projects.filter(
			(project) => project.ownerId === this.currentUser?.id,
		);
	}

	async getProjectsByType(type: ProjectType): Promise<Project[]> {
		if (!this.db) await this.initialize();

		if (!this.currentUser) {
			return [];
		}
		const tx = this.db?.transaction(this.PROJECT_STORE, 'readonly');
		const projects: Project[] = await tx.store.getAll();

		return projects.filter(
			(project) =>
				project.ownerId === this.currentUser?.id && project.type === type,
		);
	}

	async getProjectsByGroup(group: ProjectGroup): Promise<Project[]> {
		if (!this.db) await this.initialize();

		if (!this.currentUser) {
			return [];
		}

		const tx = this.db?.transaction(this.PROJECT_STORE, 'readonly');
		const projects: Project[] = await tx.store.getAll();

		return projects.filter(
			(project) =>
				project.ownerId === this.currentUser?.id &&
				(project.group ?? project.type) === group,
		);
	}

	async searchProjects(query: string): Promise<Project[]> {
		if (!this.db) await this.initialize();

		if (!this.currentUser) {
			return [];
		}

		const tx = this.db?.transaction(this.PROJECT_STORE, 'readonly');
		const projects: Project[] = await tx.store.getAll();

		const lowerQuery = query.toLowerCase();
		return projects.filter(
			(project) =>
				project.ownerId === this.currentUser?.id &&
				(project.name.toLowerCase().includes(lowerQuery) ||
					project.description.toLowerCase().includes(lowerQuery) ||
					project.type.toLowerCase().includes(lowerQuery) ||
					project.group?.toLowerCase().includes(lowerQuery) ||
					project.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))),
		);
	}

	async filterProjects(
		query = '',
		tag = '',
		type: ProjectType | '' = '',
		group: ProjectGroup | '' = '',
	): Promise<Project[]> {
		if (!this.db) await this.initialize();

		if (!this.currentUser) {
			return [];
		}

		const tx = this.db?.transaction(this.PROJECT_STORE, 'readonly');
		const projects: Project[] = await tx.store.getAll();
		const lowerQuery = query.trim().toLowerCase();

		return projects.filter(
			(project) =>
				project.ownerId === this.currentUser?.id &&
				(!tag || project.tags.includes(tag)) &&
				(!type || project.type === type) &&
				(!group || (project.group ?? project.type) === group) &&
				(!lowerQuery ||
					project.name.toLowerCase().includes(lowerQuery) ||
					project.description.toLowerCase().includes(lowerQuery) ||
					project.type.toLowerCase().includes(lowerQuery) ||
					(project.group ?? project.type).toLowerCase().includes(lowerQuery) ||
					project.tags.some((projectTag) =>
						projectTag.toLowerCase().includes(lowerQuery),
					)),
		);
	}

	async toggleFavorite(projectId: string): Promise<Project> {
		if (!this.db) await this.initialize();

		const project = await this.db?.get(this.PROJECT_STORE, projectId);
		if (!project) {
			throw new Error(t('Project not found'));
		}

		if (project.ownerId !== this.currentUser?.id) {
			throw new Error(t('You do not have permission to modify this project'));
		}

		const updatedProject: Project = {
			...project,
			isFavorite: !project.isFavorite,
			updatedAt: Date.now(),
		};

		await this.db?.put(this.PROJECT_STORE, updatedProject);
		return updatedProject;
	}
}

export const authService = new AuthService();
