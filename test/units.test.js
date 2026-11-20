'use strict';
// Clients that buy hours instead of service points.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const ledger = require('../src/ledger');
const importer = require('../src/importer');
const { clientDashboard } = require('../src/clientView');

function setup(unit) {
  const db = openDb(':memory:');
  const m = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: `Client ${unit}`, unit, termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: m.id, agreementRef: 'SOW', basePoints: unit === 'hours' ? 20.5 : 100, actor: 't' });
  return { db, id: c.id };
}
const log = (db, clientId, points, extra = {}) => importer.manualEntry(db, { clientId, state: 'used', points, title: 'Strategy call', reason: 'Call on Nov 18', workDate: '2026-11-18', actor: 't', ...extra });

test('an hours client: quarter hours, no menu needed, labels follow the unit', () => {
  const { db, id } = setup('hours');
  log(db, id, 1.5);
  log(db, id, 0.25);
  assert.throws(() => log(db, id, 1.3), /quarter hours/);
  ledger.addAllocation(db, { clientId: id, kind: 'purchase', points: 4.75, sourceRef: 'Order form 12', actor: 't' });
  const v = clientDashboard(db, id);
  assert.equal(v.unit, 'hours');
  assert.deepEqual(v.balance, { allocated: 25.25, used: 1.75, committed: 0, available: 23.5 });
});

test('a points client still needs whole numbers and a reason for off-menu work', () => {
  const { db, id } = setup('points');
  assert.throws(() => log(db, id, 1.5, { exceptionReason: 'agreed' }), /whole number/);
  assert.throws(() => log(db, id, 2), /not on the service menu/);
  assert.equal(clientDashboard(db, id).unit, 'points');
  assert.throws(() => admin.createClient(db, { name: 'X', unit: 'points', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: 1, agreementRef: 'x', basePoints: 10.5, actor: 't' }), /whole number/);
});

test('switching units: points → hours is fine; hours → points only without partial hours', () => {
  const { db, id } = setup('hours');
  log(db, id, 1.5);
  assert.throws(() => admin.updateClient(db, { clientId: id, unit: 'points', actor: 't' }), /partial hours/);
  const p = setup('points');
  admin.updateClient(p.db, { clientId: p.id, unit: 'hours', actor: 't' });
  assert.equal(clientDashboard(p.db, p.id).unit, 'hours');
  assert.throws(() => admin.updateClient(p.db, { clientId: p.id, unit: 'days', actor: 't' }), /points or hours/);
});
