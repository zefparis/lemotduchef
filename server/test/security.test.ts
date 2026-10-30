// Audit de sécurité — tests ciblés par point corrigé.
// Fichier séparé : limites rate-limit basses et config sans CORS_ORIGINS
// (l'API sert alors le statique — origine commune front/API).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..');

// Base dédiée : les fichiers de test tournent en parallèle — partager
// lemotduchef_test provoquerait des deadlocks (migrate() concurrent + écritures
// croisées sur user/session/stripe_events).
const TEST_DB = 'lemotduchef_test_sec';
{
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DB}`).catch(() => {});
  await admin.end();
}

process.env.DATABASE_URL = `postgres://lemotduchef:lemotduchef@127.0.0.1:5445/${TEST_DB}`;
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3520';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '6';
process.env.RATE_LIMIT_SIGNUP_MAX = '1000';
process.env.RATE_LIMIT_GENERATE_MAX = '10';
process.env.ADMIN_EMAILS = 'sec-admin@x.fr';
process.env.SMTP_HOST = 'log';
process.env.FREE_MONTHLY_REPLIES = '1';
process.env.LLM_PROVIDER = 'mock';
// Pas de CORS_ORIGINS : FRONT_URL = BASE_URL → le statique est servi.

const { buildApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { CGV_VERSION } = await import('../src/legal.js');
const { purgeStripeEvents, purgeExpiredReviews } = await import('../src/retention.js');
const { clientIp } = await import('../src/guards.js');
const { outbox } = await import('../src/mailer.js');

const app = await buildApp({ retention: false });
// Schéma neuf à chaque run : la base dédiée persiste entre les exécutions.
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate();
await app.ready();

const H = { 'content-type': 'application/json', 'x-lemotduchef-client': '1', host: 'localhost:3520' };
const PASSWORD = 'motdepasse1234';
const cookieOf = (r: any) => (r.headers['set-cookie'] ?? []).map((c: string) => c.split(';')[0]).join('; ');
const lastMailTo = (email: string, re: RegExp) => [...outbox].reverse().find(m => m.to === email && re.test(m.subject));
const tokenFrom = (mail: { text: string }) => /token=([A-Za-z0-9._-]+)/.exec(mail.text)?.[1];

// IP cf propre à chaque flux : la limite /api/auth/* est partagée par IP —
// chaque test utilise la sienne pour ne pas épuiser un bucket commun.
let cfSeq = 0;
const nextCf = () => `198.18.0.${++cfSeq}`;

async function secSignup(email: string, extraHeaders: Record<string, string> = {}) {
  const cf = { 'cf-connecting-ip': nextCf() };
  const r = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { ...H, ...cf, ...extraHeaders }, payload: { email, password: PASSWORD, name: 'T', cgvAccepted: true, cgvVersion: CGV_VERSION } });
  assert.equal(r.statusCode, 200, `signup ${email}: ${r.body}`);
  const mail = lastMailTo(email, /confirmez votre email/i);
  const token = tokenFrom(mail!);
  const v = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}`, headers: { host: 'localhost:3520', ...cf } });
  const c = cookieOf(v);
  if (c.includes('session_token')) return c;
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { ...H, ...cf }, payload: { email, password: PASSWORD } });
  return cookieOf(s);
}

/* ====================== C1 : garde production dans config.ts ====================== */
test('C1 : production refuse les configs invalides, accepte les valides', () => {
  const run = (over: Record<string, string>) => spawnSync(process.execPath,
    ['--import', 'tsx', '-e',
     "import('./src/config.ts').then(()=>console.log('BOOT_OK')).catch(e=>{console.error('BOOT_FAIL:'+e.message);process.exit(1)})"],
    { cwd: serverDir, encoding: 'utf8', env: {
      PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:9/x', BETTER_AUTH_SECRET: 'x'.repeat(40),
      LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', ...over } });

  const missing = run({ BETTER_AUTH_SECRET: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /BETTER_AUTH_SECRET/);

  const testKey = run({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'w' });
  assert.notEqual(testKey.status, 0);
  assert.match(testKey.stderr, /clé de test/);

  const noWh = run({ STRIPE_SECRET_KEY: 'sk_live_abc' });
  assert.notEqual(noWh.status, 0);
  assert.match(noWh.stderr, /WEBHOOK_SECRET/);

  const mock = run({ LLM_PROVIDER: 'mock' });
  assert.notEqual(mock.status, 0);
  assert.match(mock.stderr, /mock/);

  const ok = run({ STRIPE_SECRET_KEY: 'rk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /BOOT_OK/);
});

/* ====================== E2 : IP cliente = cf-connecting-ip ====================== */
test('E2 : X-Forwarded-For rotatif ne contourne pas le rate-limit', async () => {
  const get = (h: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { host: 'localhost:3520', ...h } });

  // cf-connecting-ip fixe + XFF rotatif → le 6/req-min s'applique quand même.
  let got429 = false;
  for (let i = 0; i < 10; i++) {
    const r = await get({ 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': `10.0.0.${i}` });
    if (r.statusCode === 429) got429 = true;
  }
  assert.equal(got429, true, 'cf-connecting-ip est la clé : XFF rotatif sans effet');

  // Sans en-tête proxy : IP socket partagée → limitée aussi.
  got429 = false;
  for (let i = 0; i < 10; i++) {
    const r = await get({ 'x-forwarded-for': `11.0.0.${i}` });
    if (r.statusCode === 429) got429 = true;
  }
  assert.equal(got429, true, 'IP socket utilisée quand cf-connecting-ip est absent');

  // Preuve inverse : des cf-connecting-ip distincts ouvrent des buckets distincts.
  let passed = 0;
  for (let i = 0; i < 8; i++) {
    const r = await get({ 'cf-connecting-ip': `203.0.113.${i}` });
    if (r.statusCode !== 429) passed++;
  }
  assert.equal(passed, 8, 'chaque IP cf propre a son propre budget');
});

test('E2 : clientIp préfère cf-connecting-ip, repli socket ; CGV enregistre l\'IP cf', async () => {
  const fake = (h: any, sock: string) => ({ headers: h, socket: { remoteAddress: sock } }) as any;
  assert.equal(clientIp(fake({ 'cf-connecting-ip': ' 192.0.2.1 ' }, '10.0.0.1')), '192.0.2.1');
  assert.equal(clientIp(fake({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.1')), '10.0.0.1');

  await secSignup('cgvip@s.fr', { 'cf-connecting-ip': '203.0.113.9' });
  const { rows: u } = await pool.query(`SELECT id FROM "user" WHERE email='cgvip@s.fr'`);
  const { rows: a } = await pool.query('SELECT ip FROM cgv_acceptances WHERE user_id=$1', [u[0].id]);
  assert.equal(a[0].ip, '203.0.113.9', 'IP d’acceptation CGV = cf-connecting-ip');
});

/* ====================== E3 : pas de jeton dans les logs ====================== */
test('E3 : req.url journalisée sans query → aucun token en logs', async () => {
  const chunks: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  const app2 = await buildApp({ retention: false, logStream: stream });
  await app2.ready();
  await app2.inject({ method: 'GET', url: '/api/auth/verify-email?token=TOPSECRET-ABC-123&callbackURL=x', headers: { host: 'localhost:3520' } });
  await app2.close();
  const blob = chunks.join('');
  assert.ok(!blob.includes('TOPSECRET-ABC-123'), 'le jeton ne figure dans aucune ligne de log');
  assert.ok(blob.includes('/api/auth/verify-email'), 'la route reste journalisée (pathname seul)');
});

/* ====================== M1 : suspension après mot de passe + plafond email ====================== */
test('M1 : suspension révélée seulement après vérification du mot de passe', async () => {
  const cf = { 'cf-connecting-ip': nextCf() };
  await secSignup('suspend2@s.fr');
  await pool.query(`UPDATE "user" SET suspended_at=now() WHERE email='suspend2@s.fr'`);
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { ...H, ...cf }, payload: { email: 'suspend2@s.fr', password: 'mauvais-motdepasse-9' } });
  assert.notEqual(wrong.statusCode, 403, 'un mauvais mot de passe ne doit pas révéler la suspension');
  assert.equal(wrong.statusCode, 401);
  const right = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { ...H, ...cf }, payload: { email: 'suspend2@s.fr', password: PASSWORD } });
  assert.equal(right.statusCode, 403);
  assert.match(right.body, /suspendu/i);
});

test('M1 : plafond par e-mail sur les demandes de réinitialisation', async () => {
  const cf = { 'cf-connecting-ip': nextCf() };
  const reset = (email: string) => app.inject({ method: 'POST', url: '/api/auth/request-password-reset',
    headers: { ...H, ...cf }, payload: { email, redirectTo: 'http://localhost:3520/reinitialiser' } });
  for (let i = 0; i < 3; i++) assert.equal((await reset('victim@s.fr')).statusCode, 200, `demande ${i + 1}`);
  assert.equal((await reset('victim@s.fr')).statusCode, 429, '4e demande à la même adresse bloquée');
  assert.equal((await reset('other@s.fr')).statusCode, 200, 'une autre adresse n’est pas affectée');
});

/* ====================== E5 : en-têtes de sécurité ====================== */
test('E5 : nosniff, XFO, Referrer-Policy, HSTS, CSP sur toutes les réponses', async () => {
  const api = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['x-frame-options'], 'DENY');
  assert.equal(api.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(api.headers['strict-transport-security'], 'max-age=63072000; includeSubDomains');
  assert.match(String(api.headers['content-security-policy']), /default-src 'none'/);
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
});

test('E5/F1 : vercel.json pose les en-têtes + noindex /reinitialiser ; robots.txt', () => {
  const vc = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));
  const all = vc.headers.find((h: any) => h.source === '/(.*)');
  assert.ok(all, 'bloc headers global dans vercel.json');
  const keys = all.headers.map((h: any) => h.key);
  for (const k of ['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security'])
    assert.ok(keys.includes(k), `header manquant : ${k}`);
  const reset = vc.headers.find((h: any) => h.source === '/reinitialiser');
  assert.ok(reset?.headers.some((h: any) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)), '/reinitialiser en noindex');
  assert.match(fs.readFileSync(path.join(repoRoot, 'public/robots.txt'), 'utf8'), /Disallow:\s*\/reinitialiser/);
});

/* ====================== M5 : limites mémoire déclarées ====================== */
test('M5 : docker-compose.yml borne la mémoire api et db', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /mem_limit:\s*384m/, 'api 384m');
  assert.match(compose, /mem_limit:\s*256m/, 'db 256m');
});

/* ====================== F4 : rétention des événements Stripe ====================== */
test('F4 : stripe_events purgée après 90 jours (done seulement)', async () => {
  await pool.query(`INSERT INTO stripe_events (event_id, type, status, processed_at) VALUES
    ('ev_old','x','done', now() - interval '100 days'),
    ('ev_new','x','done', now()),
    ('ev_stuck','x','processing', now() - interval '100 days')`);
  const n = await purgeStripeEvents();
  assert.equal(n, 1);
  const { rows } = await pool.query(`SELECT event_id FROM stripe_events WHERE event_id IN ('ev_old','ev_new','ev_stuck') ORDER BY 1`);
  assert.deepEqual(rows.map(r => r.event_id), ['ev_new', 'ev_stuck']);
});

/* ====================== M6 : purge du contexte étiqueté ====================== */
test('M6 : la purge efface aussi context_tags', async () => {
  const { rows: [co] } = await pool.query(`INSERT INTO companies (name) VALUES ('PurgeSec') RETURNING id`);
  const { rows: [r] } = await pool.query(
    `INSERT INTO reviews (company_id, author_name, rating, body, context_tags, created_at)
       VALUES ($1,'Z',1,'texte', '{health}', now() - interval '400 days') RETURNING id`, [co.id]);
  await purgeExpiredReviews(12);
  const { rows } = await pool.query('SELECT context_tags, body FROM reviews WHERE id=$1', [r.id]);
  assert.deepEqual(rows[0].context_tags, []);
  assert.equal(rows[0].body, '');
});

/* ====================== F6 : jetons verification supprimés ====================== */
test('F6 : aucune ligne verification ne survit à la suppression du compte', async () => {
  // Voie utilisateur (/api/auth/delete-user). verification.value = id utilisateur.
  const cf = { 'cf-connecting-ip': nextCf() };
  const c = await secSignup('delverif@s.fr', cf);
  const { rows: [u1] } = await pool.query(`SELECT id FROM "user" WHERE email='delverif@s.fr'`);
  await app.inject({ method: 'POST', url: '/api/auth/request-password-reset', headers: { ...H, ...cf }, payload: { email: 'delverif@s.fr', redirectTo: 'http://localhost:3520/reinitialiser' } });
  let { rows } = await pool.query(`SELECT count(*) AS n FROM verification WHERE value=$1`, [u1.id]);
  assert.ok(Number(rows[0].n) >= 1, 'un jeton de reset existe avant suppression');
  const del = await app.inject({ method: 'POST', url: '/api/auth/delete-user', headers: { ...H, ...cf, cookie: c }, payload: { password: PASSWORD } });
  assert.equal(del.statusCode, 200, del.body);
  ({ rows } = await pool.query(`SELECT count(*) AS n FROM verification WHERE value=$1`, [u1.id]));
  assert.equal(Number(rows[0].n), 0);

  // Voie admin (DELETE /api/admin/users/:id).
  const admin = await secSignup('sec-admin@x.fr');
  const r2 = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { ...H, 'cf-connecting-ip': nextCf() }, payload: { email: 'delverif2@s.fr', password: PASSWORD, name: 'T', cgvAccepted: true, cgvVersion: CGV_VERSION } });
  assert.equal(r2.statusCode, 200);
  const { rows: [u2] } = await pool.query(`SELECT id FROM "user" WHERE email='delverif2@s.fr'`);
  await app.inject({ method: 'POST', url: '/api/auth/request-password-reset', headers: { ...H, 'cf-connecting-ip': nextCf() }, payload: { email: 'delverif2@s.fr', redirectTo: 'http://localhost:3520/reinitialiser' } });
  const d2 = await app.inject({ method: 'DELETE', url: `/api/admin/users/${u2.id}`, headers: { ...H, cookie: admin }, payload: {} });
  assert.equal(d2.statusCode, 200, d2.body);
  ({ rows } = await pool.query(`SELECT count(*) AS n FROM verification WHERE value=$1`, [u2.id]));
  assert.equal(Number(rows[0].n), 0, 'suppression admin : jetons effacés aussi');
});

/* ====================== E4 : backup bruyant en cas d'échec ====================== */
test('E4 : backup.sh échoue bruyamment sans base (pas de dump vide)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmc-backup-'));
  const r = spawnSync('bash', [path.join(repoRoot, 'scripts/backup.sh')],
    { env: { ...process.env, BACKUP_DIR: dir }, encoding: 'utf8' });
  assert.notEqual(r.status, 0, `le script doit échouer quand pg_dump échoue : ${r.stdout}`);
  assert.match(r.stderr + r.stdout, /ERREUR/i);
  assert.deepEqual(fs.readdirSync(dir), [], 'aucun fichier vide laissé');
});

after(async () => { await app.close(); await pool.end(); });
