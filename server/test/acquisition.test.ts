import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef_test_acq';
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3510';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_SIGNUP_MAX = '1000';
process.env.ADMIN_EMAILS = 'admin@lemotduchef.test';
process.env.CORS_ORIGINS = 'https://lemotduchef.test,https://za.lemotduchef.test';
process.env.SMTP_HOST = 'log';
process.env.MAIL_FROM = 'Le Mot du Chef Test <test@lemotduchef.local>';
process.env.LLM_PROVIDER = 'mock';
process.env.IP_SALT = 'test-acq';

{
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef' });
  await admin.connect();
  await admin.query(`CREATE DATABASE "lemotduchef_test_acq"`).catch(() => {});
  await admin.end();
}

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { CGV_VERSION } = await import('../src/legal.js');

const H = { 'content-type': 'application/json', 'x-lemotduchef-client': '1', host: 'localhost:3510' };
const PASSWORD = 'Test1234!xYz';
const cookieOf = (r: any) => (r.headers['set-cookie'] || []).map((c: string) => c.split(';')[0]).join('; ');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/db.js');
  await migrate();
  app = await buildApp({ retention: false });
});
after(async () => { await app.close(); await pool.end(); });

const srcOf = async (email: string) =>
  (await pool.query<{ signup_source: string }>(`SELECT signup_source FROM "user" WHERE email=$1`, [email])).rows[0]?.signup_source;

describe('acquisition : source d\'arrivée', () => {
  test('signup_source enregistrée à l\'inscription', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H,
      payload: { email: 'src1@x.fr', password: PASSWORD, name: 'S', cgvAccepted: true, cgvVersion: CGV_VERSION, signup_source: 'flyer-cd' } });
    assert.equal(await srcOf('src1@x.fr'), 'flyer-cd');
  });
  test('valeur filtrée [a-z0-9-]{1,40} sinon « autre »', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H,
      payload: { email: 'src2@x.fr', password: PASSWORD, name: 'S', cgvAccepted: true, cgvVersion: CGV_VERSION, signup_source: 'BAD SRC;--' } });
    assert.equal(await srcOf('src2@x.fr'), 'autre');
    await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H,
      payload: { email: 'src3@x.fr', password: PASSWORD, name: 'S', cgvAccepted: true, cgvVersion: CGV_VERSION } });
    assert.equal(await srcOf('src3@x.fr'), 'autre', 'absent → autre côté serveur');
  });
  test('/api/admin/acquisition : inscriptions, activés, Pro, filtre marché', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H,
      payload: { email: 'admin@lemotduchef.test', password: PASSWORD, name: 'A', cgvAccepted: true, cgvVersion: CGV_VERSION, signup_source: 'direct' } });
    await pool.query(`UPDATE "user" SET "emailVerified"=true WHERE email='admin@lemotduchef.test'`);
    const a = { cookie: cookieOf(await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'admin@lemotduchef.test', password: PASSWORD } })) };
    // src1 : activée (entreprise + review + generation), src2 : Pro, src3 : rien.
    const co = await pool.query(`INSERT INTO companies (name, market, plan, subscription_status) VALUES ('Co Acq','fr','free','none') RETURNING id`);
    const cid = co.rows[0].id;
    const u1 = await pool.query(`SELECT id FROM "user" WHERE email='src1@x.fr'`);
    const u2 = await pool.query(`SELECT id FROM "user" WHERE email='src2@x.fr'`);
    const co2 = await pool.query(`INSERT INTO companies (name, market, plan, subscription_status) VALUES ('Co Pro','fr','pro','active') RETURNING id`);
    await pool.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1,$2,'owner')`, [u1.rows[0].id, cid]);
    await pool.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1,$2,'owner')`, [u2.rows[0].id, co2.rows[0].id]);
    const rev = await pool.query(`INSERT INTO reviews (company_id, rating) VALUES ($1,4) RETURNING id`, [cid]);
    await pool.query(`INSERT INTO generations (review_id, company_id) VALUES ($1,$2)`, [rev.rows[0].id, cid]);

    const r = await app.inject({ method: 'GET', url: '/api/admin/acquisition?days=30', headers: { ...H, ...a } });
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json().rows;
    const flyer = rows.find((x: any) => x.source === 'flyer-cd');
    assert.equal(flyer.signups, 1); assert.equal(flyer.activated, 1); assert.equal(flyer.pro, 0);
    const autre = rows.find((x: any) => x.source === 'autre');
    assert.equal(autre.signups, 2); assert.equal(autre.pro, 1);
    const direct = rows.find((x: any) => x.source === 'direct');
    assert.equal(direct.signups, 1);
    // Filtre marché : aucun compte za → vide.
    const za = await app.inject({ method: 'GET', url: '/api/admin/acquisition?days=30&market=za', headers: { ...H, ...a } });
    assert.equal(za.json().rows.length, 0);
  });
});
