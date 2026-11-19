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

module.exports = { createUser, login, logout, userForToken, hashPassword, verifyPassword };
