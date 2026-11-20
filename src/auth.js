'use strict';
// Password + session-cookie auth. Session tokens are random, stored only as hashes.
const crypto = require('node:crypto');

const SESSION_HOURS = 12;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createUser(db, { email, name, role, clientId = null, password }) {
  const r = db.prepare('INSERT INTO users (email, name, role, client_id, password_hash) VALUES (?,?,?,?,?)')
    .run(email.toLowerCase(), name, role, clientId, hashPassword(password));
  return Number(r.lastInsertRowid);
}

function login(db, email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(tokenHash(token), u.id, expires);
  return { token, user: publicUser(u) };
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

function userForToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(tokenHash(token));
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return publicUser(row);
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, client_id: u.client_id };
}

const INVITE_DAYS = 7;

/** Create a one-time link token for a user to set their password. Older unused links stop working. */
function createInvite(db, { userId, actor }) {
  const now = new Date().toISOString();
  db.prepare('UPDATE invites SET used_at = ?, replaced_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, now, userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString();
  db.prepare('INSERT INTO invites (token_hash, user_id, created_by, expires_at) VALUES (?,?,?,?)').run(tokenHash(token), userId, actor, expires);
  return { token, expires_at: expires };
}

function inviteInfo(db, token) {
  const row = db.prepare(`SELECT i.*, u.email, u.name FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?`).get(tokenHash(String(token || '')));
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) return null;
  return row;
}

/** Why a link doesn't work, in words the person can act on. */
function inviteProblem(db, token) {
  const row = db.prepare('SELECT i.*, u.password_set FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?').get(tokenHash(String(token || '')));
  if (!row) return { reason: 'unknown', error: 'We don\'t recognize this link. It may have been copied incompletely, or the person was removed. Ask your LeadG2 contact for a new one.' };
  if (row.replaced_at) return { reason: 'replaced', error: 'A newer link was created for you, so this one no longer works. Use the most recent link you were sent, or ask your LeadG2 contact for a new one.' };
  if (row.used_at) return { reason: 'used', error: 'This link was already used to set your password. Sign in with your email and that password.' };
  return { reason: 'expired', error: 'This link expired (links last 7 days). Ask your LeadG2 contact for a new one.' };
}

function acceptInvite(db, { token, password }) {
  const inv = inviteInfo(db, token);
  if (!inv) return { ok: false, ...inviteProblem(db, token) };
  if (String(password || '').length < 10) return { ok: false, error: 'Choose a password with at least 10 characters.' };
  db.prepare('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(password), inv.user_id);
  db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(new Date().toISOString(), inv.token_hash);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(inv.user_id);
  return { ok: true, email: inv.email };
}

module.exports = { createInvite, inviteInfo, inviteProblem, acceptInvite, createUser, login, logout, userForToken, hashPassword, verifyPassword };
