#!/usr/bin/env node
// server/auth.js — Tier 1 server-side accounts, sessions and project ACL.
// Shared by yjs-ws-server.js and terminal-server.js (plain CommonJS, no deps).
//
// Storage (git-ignored, all under server/):
//   .users.json     { username: { salt, hash, createdAt } }   scrypt-hashed
//   .sessions.json  { token: { username, expiresAt } }        random 32B tokens
//   .projects.json  { projectId: { name, owner, members[] } }
//   .invite-code    registration invite code (set by start.sh)
//
// Registration policy: if an invite code is configured, registration
// requires it. Otherwise anyone who passed the site gate can register.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Data directory for accounts/sessions/ACL files. Overridable (LTC_DATA_DIR)
// so tests can use an isolated store.
const DATA_DIR = process.env.LTC_DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, '.users.json');
const SESSIONS_FILE = path.join(DATA_DIR, '.sessions.json');
const PROJECTS_FILE = path.join(DATA_DIR, '.projects.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_KEYLEN = 64;

const INVITE_CODE = process.env.INVITE_CODE || '';

// ---- helpers ----
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadUsers() {
  return readJson(USERS_FILE, {});
}

function saveUsers(users) {
  writeJson(USERS_FILE, users);
}

function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

function saveSessions(sessions) {
  writeJson(SESSIONS_FILE, sessions);
}

function loadProjects() {
  return readJson(PROJECTS_FILE, {});
}

function saveProjects(projects) {
  writeJson(PROJECTS_FILE, projects);
}

function hashPassword(password, salt) {
  const buf = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return buf.toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const hash = hashPassword(password, salt);
  return hash.length === expectedHash.length && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Ensure the sessions file exists (used by yjs-ws-server at startup so
// terminal-server's AUTH_MODE detection works before the first login).
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) {
    writeJson(SESSIONS_FILE, {});
  }
  if (!fs.existsSync(USERS_FILE)) {
    writeJson(USERS_FILE, {});
  }
  if (!fs.existsSync(PROJECTS_FILE)) {
    writeJson(PROJECTS_FILE, {});
  }
}

// ---- username / password validation ----
function isValidUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(username);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

// ---- registration ----
// Returns { ok:true, user } or { ok:false, error }.
function registerUser(username, password, inviteCode) {
  if (!isValidUsername(username)) {
    return { ok: false, error: 'invalid username (3-32 chars, letters/digits/._-)' };
  }
  if (!isValidPassword(password)) {
    return { ok: false, error: 'password too short (min 8 chars)' };
  }
  if (INVITE_CODE && inviteCode !== INVITE_CODE) {
    return { ok: false, error: 'invalid invite code' };
  }
  const users = loadUsers();
  if (users[username]) {
    return { ok: false, error: 'username already exists' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  users[username] = {
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
  };
  saveUsers(users);
  console.log(`  [auth] registered user: ${username}`);
  return { ok: true, user: { username, createdAt: users[username].createdAt } };
}

// ---- login / logout ----
// Returns { ok:true, token, user } or { ok:false, error }.
function loginUser(username, password) {
  if (!isValidUsername(username)) return { ok: false, error: 'invalid username' };
  const users = loadUsers();
  const user = users[username];
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return { ok: false, error: 'invalid username or password' };
  }
  const token = randomToken();
  const sessions = loadSessions();
  sessions[token] = { username, expiresAt: Date.now() + SESSION_TTL_MS };
  saveSessions(sessions);
  console.log(`  [auth] login: ${username}`);
  return {
    ok: true,
    token,
    user: { username, createdAt: user.createdAt },
  };
}

function logoutToken(token) {
  const sessions = loadSessions();
  if (sessions[token]) {
    delete sessions[token];
    saveSessions(sessions);
    return true;
  }
  return false;
}

// ---- session validation ----
// Returns the username or null. Lazily purges expired sessions.
function validateSession(token) {
  if (typeof token !== 'string' || token.length < 32) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  return session.username;
}

// ---- project ACL ----
function registerProject(projectId, name, owner) {
  const projects = loadProjects();
  if (projects[projectId]) {
    const p = projects[projectId];
    if (p.owner === owner || p.members.includes(owner)) return { ok: true, project: p };
    return { ok: false, error: 'project already registered to another owner' };
  }
  const project = { name: String(name || projectId).slice(0, 120), owner, members: [owner] };
  projects[projectId] = project;
  saveProjects(projects);
  console.log(`  [acl] project registered: ${projectId} (owner: ${owner})`);
  return { ok: true, project };
}

function shareProject(projectId, username, actor) {
  const projects = loadProjects();
  const project = projects[projectId];
  if (!project) return { ok: false, error: 'project not found' };
  if (project.owner !== actor) return { ok: false, error: 'only the owner can share' };
  if (!loadUsers()[username]) return { ok: false, error: 'user not found' };
  if (!project.members.includes(username)) {
    project.members.push(username);
    saveProjects(projects);
    console.log(`  [acl] shared ${projectId} with ${username}`);
  }
  return { ok: true, project };
}

function unshareProject(projectId, username, actor) {
  const projects = loadProjects();
  const project = projects[projectId];
  if (!project) return { ok: false, error: 'project not found' };
  if (project.owner !== actor) return { ok: false, error: 'only the owner can unshare' };
  project.members = project.members.filter((m) => m !== username);
  saveProjects(projects);
  return { ok: true, project };
}

function listProjectsFor(username) {
  const projects = loadProjects();
  const result = [];
  for (const [id, p] of Object.entries(projects)) {
    if (p.owner === username || p.members.includes(username)) {
      result.push({ id, name: p.name, owner: p.owner });
    }
  }
  return result;
}

function isProjectMember(projectId, username) {
  if (typeof username !== 'string' || !username) return false;
  const project = loadProjects()[projectId];
  if (!project) return false;
  return project.owner === username || project.members.includes(username);
}

module.exports = {
  init,
  registerUser,
  loginUser,
  logoutToken,
  validateSession,
  registerProject,
  shareProject,
  unshareProject,
  listProjectsFor,
  isProjectMember,
  isValidUsername,
  isValidPassword,
  USERS_FILE,
  SESSIONS_FILE,
  PROJECTS_FILE,
  hasInviteCode: () => !!INVITE_CODE,
};
