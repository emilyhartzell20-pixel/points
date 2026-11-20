'use strict';
// Create a LeadG2 admin account and print a one-time link to set its password.
//   npm run create-admin -- you@leadg2.com "Your Name"
// Use this once to create the first admin; add everyone else from Admin → LeadG2 team.
const { openDb } = require('../src/db');
const admin = require('../src/admin');

const [email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ');
if (!email || !name) {
  console.error('Usage: npm run create-admin -- you@leadg2.com "Your Name"');
  process.exit(1);
}
try {
  const db = openDb();
  const r = admin.inviteStaff(db, { email, name, actor: 'command-line' });
  const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  console.log(`Admin account created for ${name} <${email.toLowerCase()}>.`);
  console.log('Start the app (npm start), then open this link to choose a password (works once, expires in 7 days):');
  console.log(`  ${base}/setup#t=${r.token}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
