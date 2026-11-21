import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { checkKey, decryptSecret, encryptSecret, TokenCryptoError } from '../src/token-crypto.js';
import { getConnection, markDisconnected, readRefreshToken, recordRefresh, saveRefreshToken } from '../src/calendar-connections.js';
import { createTestDb } from './helpers/d1.js';

const newKey = () => randomBytes(32).toString('base64');
const TOKEN = 'fake-refresh-token-for-tests-1234567890';
const NOW = 1_800_000_000;

function setup() {
  const db = createTestDb();
  const encKey = newKey();
  const save = (over = {}) =>
    saveRefreshToken({ db, encKey, discordUserId: 'u1', teamId: 'g1', googleEmail: 'pm@example.com', refreshToken: TOKEN, nowSec: NOW, ...over });
  return { db, encKey, save };
}

test('a stored token reads back, and the raw database value is not readable', async () => {
  const { db, encKey, save } = setup();
  assert.deepEqual(await save(), { ok: true });

  const raw = db.sql('SELECT * FROM calendar_connections')[0];
  assert.equal(raw.status, 'connected');
  assert.equal(raw.team_id, 'g1');
  assert.equal(raw.token_issued_at, NOW);
  // Nothing stored contains the token, in any column, as text or base64.
  const everything = JSON.stringify(raw);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes(Buffer.from(TOKEN).toString('base64')));
  assert.ok(raw.encrypted_refresh_token.length > 0 && raw.iv.length > 0);

  assert.equal(await readRefreshToken({ db, encKey, discordUserId: 'u1' }), TOKEN);
});

test('every record gets its own random IV, so the same token never encrypts the same way twice', async () => {
  const key = newKey();
  const a = await encryptSecret(key, TOKEN, 'u1');
  const b = await encryptSecret(key, TOKEN, 'u1');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(Buffer.from(a.iv, 'base64').length, 12);
});

test('decryption fails (with a fixed message) for the wrong key, the wrong owner, and tampered data', async () => {
  const key = newKey();
  const sealed = await encryptSecret(key, TOKEN, 'u1');
  assert.equal(await decryptSecret(key, sealed, 'u1'), TOKEN);

  const failures = [
    () => decryptSecret(newKey(), sealed, 'u1'), // another key
    () => decryptSecret(key, sealed, 'u2'), // a row copied to another person
    () => {
      const bytes = Buffer.from(sealed.ciphertext, 'base64');
      bytes[0] ^= 1;
      return decryptSecret(key, { ...sealed, ciphertext: bytes.toString('base64') }, 'u1'); // changed data
    },
  ];
  for (const attempt of failures) {
    await assert.rejects(attempt, (e) => {
      assert.ok(e instanceof TokenCryptoError);
      assert.ok(!e.message.includes(TOKEN) && !e.message.includes(key) && !e.message.includes(sealed.ciphertext));
      return true;
    });
  }
});

test('a missing or malformed TOKEN_ENC_KEY is refused without echoing it', async () => {
  const bad = ['', undefined, 'not base64 !!', randomBytes(16).toString('base64'), randomBytes(33).toString('base64')];
  for (const k of bad) {
    const problem = await checkKey(k);
    assert.ok(problem, `expected a problem for ${String(k).slice(0, 10)}`);
    if (k) assert.ok(!problem.includes(String(k)));
    await assert.rejects(encryptSecret(k, TOKEN, 'u1'), TokenCryptoError);
  }
  assert.equal(await checkKey(newKey()), null);
});

test('an already-connected PM is refused and their stored token is left exactly as it was', async () => {
  const { db, encKey, save } = setup();
  await save();
  const before = db.sql('SELECT * FROM calendar_connections')[0];

  const second = await save({ refreshToken: 'a-different-fake-token', googleEmail: 'other@example.com', nowSec: NOW + 5 });
  assert.deepEqual(second, { ok: false, reason: 'already-connected' });

  assert.deepEqual(db.sql('SELECT * FROM calendar_connections')[0], before);
  assert.equal(await readRefreshToken({ db, encKey, discordUserId: 'u1' }), TOKEN);
});

test('disconnecting wipes the token, and the PM can then connect again', async () => {
  const { db, encKey, save } = setup();
  await save();
  await markDisconnected(db, 'u1', 'invalid_grant', NOW + 10);

  const row = await getConnection(db, 'u1');
  assert.equal(row.status, 'disconnected');
  assert.equal(row.encrypted_refresh_token, null);
  assert.equal(row.iv, null);
  assert.equal(row.last_refresh_result, 'invalid_grant');
  assert.equal(await readRefreshToken({ db, encKey, discordUserId: 'u1' }), null);

  assert.deepEqual(await save({ refreshToken: 'fresh-fake-token', nowSec: NOW + 20 }), { ok: true });
  assert.equal((await getConnection(db, 'u1')).token_issued_at, NOW + 20);
  assert.equal(await readRefreshToken({ db, encKey, discordUserId: 'u1' }), 'fresh-fake-token');
});

test('connections are separate per PM: one PM never reads, or overwrites, another\'s token', async () => {
  const { db, encKey, save } = setup();
  await save();
  await save({ discordUserId: 'u2', teamId: 'g2', googleEmail: 'second@example.com', refreshToken: 'second-fake-token' });
  assert.equal(await readRefreshToken({ db, encKey, discordUserId: 'u1' }), TOKEN);
  assert.equal(await readRefreshToken({ db, encKey, discordUserId: 'u2' }), 'second-fake-token');

  // Swapping one row's ciphertext into the other's does not decrypt (the owner is part of the encryption).
  const [a, b] = ['u1', 'u2'].map((id) => db.sql('SELECT * FROM calendar_connections WHERE discord_user_id = ?', id)[0]);
  await db.prepare('UPDATE calendar_connections SET encrypted_refresh_token = ?, iv = ? WHERE discord_user_id = ?').bind(a.encrypted_refresh_token, a.iv, 'u2').run();
  await assert.rejects(readRefreshToken({ db, encKey, discordUserId: 'u2' }), TokenCryptoError);
  assert.ok(b);
});

test('recordRefresh stores the result and a row cannot be half-connected', async () => {
  const { db, save } = setup();
  await save();
  await recordRefresh(db, 'u1', 'ok', NOW + 100);
  const row = await getConnection(db, 'u1');
  assert.equal(row.last_refresh_at, NOW + 100);
  assert.equal(row.last_refresh_result, 'ok');

  // The table itself refuses a "connected" row with no token (or a "disconnected" row that kept one).
  assert.throws(() =>
    db.sql("INSERT INTO calendar_connections (discord_user_id, team_id, google_email, status, token_issued_at) VALUES ('x','g','e@example.com','connected',1) RETURNING *"),
  );
  assert.throws(() =>
    db.sql("INSERT INTO calendar_connections (discord_user_id, team_id, google_email, encrypted_refresh_token, iv, status, token_issued_at) VALUES ('y','g','e@example.com','c','i','disconnected',1) RETURNING *"),
  );
});
