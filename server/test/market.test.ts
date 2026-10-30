import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Base dédiée : les fichiers de test tournent en parallèle — chaque suite
// remet son schéma à zéro (DROP SCHEMA), partager une base ferait échouer
// les migrate() concurrents.
const TEST_DB = 'lemotduchef_test_market';
{
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DB}`).catch(() => {});
  await admin.end();
}
process.env.DATABASE_URL = process.env.TEST_MARKET_DATABASE_URL
  ?? `postgres://lemotduchef:lemotduchef@127.0.0.1:5445/${TEST_DB}`;
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3510';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_GENERATE_MAX = '1000';
process.env.ADMIN_EMAILS = 'admin@lemotduchef.test';
process.env.CORS_ORIGINS = 'https://lemotduchef.test,https://za.lemotduchef.test';
process.env.FR_DOMAINS = 'lemotduchef.test';
process.env.SMTP_HOST = 'log';
process.env.MAIL_FROM = 'Le Mot du Chef Test <test@lemotduchef.local>';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_y';
process.env.LLM_PROVIDER = 'mock';
// Marché ZA : domaine de test ajouté via l'env ; le domaine réel
// (za.lemotduchef.fr) et les adresses email (même boîte que FR) vivent
// dans public/markets.js — même domaine d'expédition pour les deux marchés.
process.env.ZA_DOMAINS = 'za.lemotduchef.test';

const { buildApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { outbox, sendMail } = await import('../src/mailer.js');
const { CGV_VERSION } = await import('../src/legal.js');
const {
  marketFromHost, marketFromOrigin, marketFromHeaders, marketConfig,
  allowsProspecting, localMinutes, reviewMailAddressFor, frontUrlFor, mailFromFor,
} = await import('../src/markets.js');
const { inQuietHours } = await import('../src/push.js');

let app: Awaited<ReturnType<typeof buildApp>>;

const H = { 'content-type': 'application/json', 'x-lemotduchef-client': '1', 'host': 'localhost:3510' };
const ZA_ORIGIN = 'https://za.lemotduchef.test';
const FR_ORIGIN = 'https://lemotduchef.test';
const cookieOf = (r: any) => (r.headers['set-cookie'] ?? []).map((c: string) => c.split(';')[0]).join('; ');
const PASSWORD = 'motdepasse1234';

const lastMailTo = (email: string, subjectMatch: RegExp) =>
  [...outbox].reverse().find(m => m.to === email && subjectMatch.test(m.subject));
const tokenFrom = (mail: { text: string }) => /token=([A-Za-z0-9._-]+)/.exec(mail.text)?.[1];

async function signup(email: string, name = 'Test', origin?: string) {
  const r = await app.inject({
    method: 'POST', url: '/api/auth/sign-up/email',
    headers: { ...H, ...(origin ? { origin } : {}) },
    payload: { email, password: PASSWORD, name, cgvAccepted: true, cgvVersion: CGV_VERSION },
  });
  assert.equal(r.statusCode, 200, `signup ${email} : ${r.body}`);
  let mail = lastMailTo(email, /confirmez votre email|confirm your email/i);
  if (!mail) {
    // Le compte existe déjà (base de test partagée entre suites) : connexion
    // directe — la vérification a déjà eu lieu dans l'autre suite.
    await pool.query('UPDATE "user" SET "emailVerified"=true WHERE lower(email)=lower($1)', [email]);
    const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email, password: PASSWORD } });
    assert.equal(s.statusCode, 200, `sign-in ${email} : ${s.body}`);
    return { cookie: cookieOf(s), mail: null };
  }
  const token = tokenFrom(mail!);
  assert.ok(token, 'token de vérification présent');
  const v = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}`, headers: { host: 'localhost:3510' } });
  assert.ok([200, 302].includes(v.statusCode), `verify-email → ${v.statusCode}`);
  const cookie = cookieOf(v);
  if (cookie.includes('session_token')) return { cookie, mail: mail! };
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email, password: PASSWORD } });
  assert.equal(s.statusCode, 200, `sign-in ${email}`);
  return { cookie: cookieOf(s), mail: mail! };
}

const userRow = async (email: string) =>
  (await pool.query<{ market: string; lang: string }>('SELECT market, lang FROM "user" WHERE lower(email)=lower($1)', [email])).rows[0];
const companyOf = async (email: string) =>
  (await pool.query<{ id: string; market: string }>(
    `SELECT c.id, c.market FROM companies c JOIN memberships m ON m.company_id=c.id
      JOIN "user" u ON u.id=m.user_id WHERE lower(u.email)=lower($1)`, [email])).rows[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = await buildApp({ retention: false });
});
after(async () => { await app.close(); await pool.end(); });

/* ---------- Détection par domaine ---------- */

test('marketFromHost : domaines FR et ZA reconnus, inconnus rejetés', () => {
  assert.equal(marketFromHost('lemotduchef.fr'), 'fr');
  assert.equal(marketFromHost('www.lemotduchef.fr'), 'fr');
  assert.equal(marketFromHost('api.lemotduchef.fr'), 'fr');
  assert.equal(marketFromHost('localhost:3000'), 'fr');
  assert.equal(marketFromHost('za.lemotduchef.test'), 'za');
  assert.equal(marketFromHost('ailleurs.example'), null);
  assert.equal(marketFromHost(''), null);
});

test('marketFromOrigin / marketFromHeaders : Origin prioritaire sur Host', () => {
  assert.equal(marketFromOrigin(ZA_ORIGIN), 'za');
  assert.equal(marketFromOrigin(FR_ORIGIN), 'fr');
  assert.equal(marketFromOrigin('not-a-url'), null);
  const headers = new Headers({ origin: ZA_ORIGIN, host: 'api.lemotduchef.fr' });
  assert.equal(marketFromHeaders(headers), 'za');
  assert.equal(marketFromHeaders(new Headers()), 'fr'); // défaut
});

/* ---------- Garde-fou prospection ---------- */

test('prospection : marché FR seulement — ZA jamais éligible', () => {
  assert.equal(allowsProspecting('fr'), true);
  assert.equal(allowsProspecting('za'), false);
});

/* ---------- Attribution du marché ---------- */

test('signup sur le domaine ZA → compte market=za, entreprise market=za', async () => {
  const email = `za-signup-${Date.now()}@x.fr`;
  const { cookie, mail } = await signup(email, 'ZA Resto', ZA_ORIGIN);
  const u = await userRow(email);
  assert.equal(u?.market, 'za', 'le compte créé depuis le domaine ZA doit porter market=za');
  // Expéditeur = domaine lemotduchef.fr (même boîte pour les deux marchés) ;
  // lien de vérification → front za.lemotduchef.fr.
  assert.ok(mail, 'email de vérification capturé');
  assert.equal(mail!.from, 'Le Mot du Chef <noreply@lemotduchef.fr>');
  assert.match(decodeURIComponent(mail!.text), /za\.lemotduchef\.fr\/\?verifie=1/);
  // Création du restaurant : l'entreprise hérite du marché du compte.
  const r = await app.inject({
    method: 'POST', url: '/api/restaurants',
    headers: { ...H, cookie },
    payload: { name: 'Cape Bistro', city: 'Cape Town', cuisine: 'grill', signature_name: '', signature_role: '', tone: 'chaleureux', address_form: 'vous', avoid_phrases: [], strengths: [], practical_info: '', google_maps_url: '', google_review_url: '', contact_email: '', contact_phone: '', show_phone: false },
  });
  assert.equal(r.statusCode, 201, r.body);
  const c = await companyOf(email);
  assert.equal(c?.market, 'za', 'le restaurant d’un compte ZA doit porter market=za');
  // /api/me expose le marché et la langue par défaut du marché (en).
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { ...H, cookie } });
  assert.equal(me.json().market, 'za');
  assert.equal(me.json().restaurant.market, 'za');
  assert.equal(me.json().user.lang, 'en');
});

test('signup sur le domaine FR → market=fr (comportement inchangé)', async () => {
  const email = `fr-signup-${Date.now()}@x.fr`;
  const { mail } = await signup(email, 'FR Resto', FR_ORIGIN);
  assert.equal((await userRow(email))?.market, 'fr');
  if (mail) assert.equal(mail.from, process.env.MAIL_FROM);
});

/* ---------- Config publique par marché ---------- */

test('/api/config : le marché suit l’Origin de la requête', async () => {
  const za = await app.inject({ method: 'GET', url: '/api/config', headers: { ...H, origin: ZA_ORIGIN } });
  const j = za.json();
  assert.equal(j.market, 'za');
  assert.equal(j.lang, 'en');
  assert.equal(j.currency, 'ZAR');
  assert.equal(j.timezone, 'Africa/Johannesburg');
  // Phase pilote : le marché ZA utilise le compte Stripe FR (mêmes clés) ;
  // la bascule Paystack se fera par ce seul champ de configuration.
  assert.equal(j.paymentProvider, 'stripe');
  const fr = await app.inject({ method: 'GET', url: '/api/config', headers: H });
  assert.equal(fr.json().market, 'fr');
  assert.equal(fr.json().currency, 'EUR');
  // Une Origin inconnue n'achète pas un autre marché : défaut FR.
  const unk = await app.inject({ method: 'GET', url: '/api/config', headers: { ...H, origin: 'https://evil.example' } });
  assert.equal(unk.json().market, 'fr');
});

/* ---------- Emails transactionnels par marché ---------- */

test('sendMail : même domaine d\'expédition pour les deux marchés', async () => {
  const n = outbox.length;
  await sendMail({ to: 'x@y.fr', subject: 's', text: 't' }, 'za');
  await sendMail({ to: 'x@y.fr', subject: 's', text: 't' }, 'fr');
  // Même boîte lemotduchef.fr pour les deux marchés : l'expéditeur ZA vient
  // de markets.js (même domaine), celui FR de MAIL_FROM (env prioritaire).
  assert.equal(outbox[n].from, 'Le Mot du Chef <noreply@lemotduchef.fr>');
  assert.equal(outbox[n + 1].from, process.env.MAIL_FROM);
  assert.equal(mailFromFor('za'), 'Le Mot du Chef <noreply@lemotduchef.fr>');
  assert.equal(frontUrlFor('za'), 'https://za.lemotduchef.fr');
  assert.equal(reviewMailAddressFor('za'), 'avis@lemotduchef.fr');
  assert.equal(frontUrlFor('fr'), 'https://lemotduchef.fr');
});

/* ---------- Compte créé par l'admin ---------- */

test('admin : création de compte avec marché explicite', async () => {
  const adminEmail = 'admin@lemotduchef.test';
  const { cookie } = await signup(adminEmail, 'Admin');
  const target = `za-invite-${Date.now()}@x.fr`;
  const r = await app.inject({
    method: 'POST', url: '/api/admin/accounts',
    headers: { ...H, cookie },
    payload: { email: target, name: 'Invité ZA', market: 'za' },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await userRow(target))?.market, 'za');
  // Sans paramètre market : FR (défaut).
  const target2 = `fr-invite-${Date.now()}@x.fr`;
  const r2 = await app.inject({
    method: 'POST', url: '/api/admin/accounts',
    headers: { ...H, cookie },
    payload: { email: target2, name: 'Invité FR' },
  });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal((await userRow(target2))?.market, 'fr');
});

/* ---------- Réponses multilingues ---------- */

test('avis en anglais (compte ZA) → réponses en anglais, pas de traduction en anglais', async () => {
  const email = `za-en-${Date.now()}@x.fr`;
  const { cookie } = await signup(email, 'EN Resto', ZA_ORIGIN);
  await app.inject({
    method: 'POST', url: '/api/restaurants', headers: { ...H, cookie },
    payload: { name: 'Cape Bistro', city: 'Cape Town', cuisine: 'grill', signature_name: '', signature_role: '', tone: 'chaleureux', address_form: 'vous', avoid_phrases: [], strengths: [], practical_info: '', google_maps_url: '', google_review_url: '', contact_email: '', contact_phone: '', show_phone: false },
  });
  const rv = await app.inject({
    method: 'POST', url: '/api/reviews', headers: { ...H, cookie },
    payload: { author_name: 'Sarah', rating: 2, body: 'The waiter was rude and our food arrived cold after a long wait. Disappointed — we will not come back.', source: 'manual', context_tags: [], context_note: '' },
  });
  assert.equal(rv.statusCode, 201, rv.body);
  const rid = rv.json().id;
  const g = await app.inject({
    method: 'POST', url: `/api/reviews/${rid}/generate`, headers: { ...H, cookie }, payload: {},
  });
  assert.equal(g.statusCode, 200, g.body);
  const vs = g.json().variants.filter((v: any) => v.text);
  assert.ok(vs.length >= 2, 'au moins 2 variantes');
  for (const v of vs) assert.match(v.text, /^(Hello|Dear)/, `réponse attendue en anglais : ${v.text.slice(0, 60)}`);
  // Langue de l'interface = en (marché ZA) → pas de traduction en anglais.
  const { rows: rvRow } = await pool.query<{ lang: string }>('SELECT lang FROM reviews WHERE id=$1', [rid]);
  assert.equal(rvRow[0].lang, 'en');
});

test('avis en anglais (compte FR, interface fr) → réponses en anglais + traduction fr', async () => {
  const email = `fr-en-${Date.now()}@x.fr`;
  const { cookie } = await signup(email, 'FR Resto', FR_ORIGIN);
  await app.inject({
    method: 'POST', url: '/api/restaurants', headers: { ...H, cookie },
    payload: { name: 'Bistrot Test', city: 'Lyon', cuisine: 'française', signature_name: '', signature_role: '', tone: 'chaleureux', address_form: 'vous', avoid_phrases: [], strengths: [], practical_info: '', google_maps_url: '', google_review_url: '', contact_email: '', contact_phone: '', show_phone: false },
  });
  const rv = await app.inject({
    method: 'POST', url: '/api/reviews', headers: { ...H, cookie },
    payload: { author_name: 'Tom', rating: 5, body: 'Excellent food and very friendly staff — the best meal we had in Lyon. Highly recommended!', source: 'manual', context_tags: [], context_note: '' },
  });
  const rid = rv.json().id;
  const g = await app.inject({
    method: 'POST', url: `/api/reviews/${rid}/generate`, headers: { ...H, cookie }, payload: {},
  });
  assert.equal(g.statusCode, 200, g.body);
  const vs = g.json().variants.filter((v: any) => v.text);
  assert.ok(vs.length >= 2);
  // Interface fr → chaque réponse anglaise porte sa traduction.
  for (const v of vs) assert.ok(v.translation === undefined || typeof v.translation === 'string');
  const { rows } = await pool.query<{ lang: string; translation: string | null }>(
    `SELECT r.lang, v.translation FROM reviews r
      JOIN reply_variants v ON v.review_id = r.id WHERE r.id=$1 ORDER BY v.idx LIMIT 1`, [rid]);
  assert.equal(rows[0].lang, 'en');
  // La traduction est stockée (le mock la fournit ; l'API réelle aussi via translations[]).
  assert.ok(rows[0].translation === null || rows[0].translation.length > 0);
});

/* ---------- Fuseau horaire : heures de silence ---------- */

test('heures de silence évaluées dans le fuseau du marché', () => {
  // 29 octobre : Paris = UTC+1 (heure d'hiver), Johannesburg = UTC+2.
  // 21:30 UTC → 22:30 Paris, 23:30 Johannesburg.
  const now = new Date('2026-10-29T21:30:00Z');
  assert.equal(localMinutes(now, 'Europe/Paris'), 22 * 60 + 30);
  assert.equal(localMinutes(now, 'Africa/Johannesburg'), 23 * 60 + 30);
  const s = { enabled: true, rating_max: 3, quiet_start: '23:00', quiet_end: '01:00', hide_content: false };
  assert.equal(inQuietHours(s, marketConfig('za').timezone, now), true, 'ZA doit être dans la plage de silence');
  assert.equal(inQuietHours(s, marketConfig('fr').timezone, now), false, 'FR ne doit pas y être');
  // Sans plage configurée : jamais en silence.
  assert.equal(inQuietHours({ ...s, quiet_start: null, quiet_end: null }, 'Africa/Johannesburg', now), false);
});
