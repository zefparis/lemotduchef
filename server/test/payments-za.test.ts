import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Stripe from 'stripe';

// Même compte Stripe que le marché FR (mêmes clés) : seuls les ids de
// prix diffèrent pour ZA (objets ZAR du même compte, fournis par env).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef_test_payza';
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3510';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_GENERATE_MAX = '1000';
process.env.ADMIN_EMAILS = 'admin@lemotduchef.test';
process.env.CORS_ORIGINS = 'https://lemotduchef.test,https://za.lemotduchef.test,https://ke.lemotduchef.test,https://cd.lemotduchef.test';
process.env.FR_DOMAINS = 'lemotduchef.test';
process.env.ZA_DOMAINS = 'za.lemotduchef.test';
process.env.SMTP_HOST = 'log';
process.env.MAIL_FROM = 'Le Mot du Chef Test <test@lemotduchef.local>';
process.env.LLM_PROVIDER = 'mock';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_payza';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_fr_m';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_fr_y';
process.env.STRIPE_ZA_PRICE_PRO_MONTHLY = 'price_za_m';
process.env.STRIPE_ZA_PRICE_PRO_YEARLY = 'price_za_y';
process.env.STRIPE_KE_PRICE_PRO_MONTHLY = 'price_ke_m';
process.env.STRIPE_KE_PRICE_PRO_YEARLY = 'price_ke_y';
process.env.KE_ORIGIN_TEST = 'https://ke.lemotduchef.test';
process.env.STRIPE_CD_PRICE_PRO_MONTHLY = 'price_cd_m';
process.env.STRIPE_CD_PRICE_PRO_YEARLY = 'price_cd_y';
process.env.PAYSTACK_ZA_SECRET_KEY = 'sk_test_paystack';
process.env.PAYSTACK_ZA_PLAN_MONTHLY = 'PLN_test_m';
process.env.PAYSTACK_ZA_PLAN_YEARLY = 'PLN_test_y';
process.env.IP_SALT = 'test-payza';

// Base dédiée (créée avant import de db/app, même mécanique que market.test).
const TEST_DB = 'lemotduchef_test_payza';
{
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef' });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${TEST_DB}"`).catch(() => {});
  await admin.end();
}

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { stripe } = await import('../src/stripe.js');
const { CGV_VERSION } = await import('../src/legal.js');

const PASSWORD = 'Test1234!xYz';
const H = { 'content-type': 'application/json', 'x-lemotduchef-client': '1', host: 'localhost:3510' };
const ZA = 'https://za.lemotduchef.test';
const KE = 'https://ke.lemotduchef.test';
const CD = 'https://cd.lemotduchef.test';
const cookieOf = (r: any) => (r.headers['set-cookie'] || []).map((c: string) => c.split(';')[0]).join('; ');
const stripeClient = new Stripe('sk_test_fake');

const lastMailTo = async (email: string) => {
  const { outbox } = await import('../src/mailer.js');
  return [...outbox].reverse().find(m => m.to === email);
};

async function signupZa(email: string, za = true) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email',
    headers: { ...H, ...(za ? { origin: ZA } : {}) },
    payload: { email, password: PASSWORD, name: 'ZA Test', cgvAccepted: true, cgvVersion: CGV_VERSION } });
  assert.equal(r.statusCode, 200, `signup ${email}: ${r.body}`);
  const mail = await lastMailTo(email);
  const token = /token=([A-Za-z0-9._-]+)/.exec(mail?.text ?? '')?.[1];
  const v = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}`, headers: { host: 'localhost:3510' } });
  const cookie = cookieOf(v);
  if (cookie.includes('session_token')) return cookie;
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email, password: PASSWORD } });
  return cookieOf(s);
}

async function makeCompany(cookie: string, name: string, za = true) {
  const r = await app.inject({ method: 'POST', url: '/api/restaurants',
    headers: { ...H, cookie, ...(za ? { origin: ZA } : {}) }, payload: { name } });
  assert.ok([200, 201].includes(r.statusCode), `company ${name}: ${r.statusCode} ${r.body}`);
  const j = r.json();
  return (j.company?.id ?? j.id ?? j.restaurant?.company_id) as string;
}

const whStripe = (event: object) => ({
  method: 'POST' as const, url: '/api/stripe/webhook',
  headers: { ...H, 'stripe-signature': stripeClient.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: 'whsec_payza' }) },
  payload: JSON.stringify(event),
});

const whPaystack = (event: object) => {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac('sha512', 'sk_test_paystack').update(raw).digest('hex');
  return { method: 'POST' as const, url: '/api/paystack/webhook', headers: { ...H, 'x-paystack-signature': sig }, payload: raw };
};

const billingOf = async (companyId: string) =>
  (await pool.query<any>(`SELECT plan, subscription_status, payment_provider, paystack_subscription_code FROM companies WHERE id=$1`, [companyId])).rows[0];

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/db.js');
  await migrate();
  app = await buildApp({ retention: false });
});
after(async () => { await app.close(); await pool.end(); });

describe('paiement marché ZA', () => {

  test('ZA : /api/billing expose les prix ZAR (env STRIPE_ZA_PRICE_*)', async () => {
    const cookie = await signupZa('billing@za.test');
    await makeCompany(cookie, 'Resto ZA');
    const r = await app.inject({ method: 'GET', url: '/api/billing', headers: { ...H, cookie, origin: ZA } });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.enabled, true);
    assert.deepEqual(b.prices.map((p: any) => p.id).sort(), ['price_za_m', 'price_za_y']);
  });

  test('ZA : checkout Stripe locale en + URLs ZA + provider mémorisé', async () => {
    const cookie = await signupZa('checkout@za.test');
    const cid = await makeCompany(cookie, 'Resto ZA Co');
    const s = stripe()!;
    const calls: any[] = [];
    const origList = s.customers.list, origCreate = s.customers.create, origSess = s.checkout.sessions.create;
    s.customers.list = async () => ({ data: [] }) as any;
    s.customers.create = async (p: any) => ({ id: 'cus_za_1', ...p }) as any;
    s.checkout.sessions.create = async (p: any) => { calls.push(p); return { id: 'cs_za', url: 'https://checkout.stripe.test/cs_za' } as any; };
    try {
      const r = await app.inject({ method: 'POST', url: '/api/billing/checkout',
        headers: { ...H, cookie, origin: ZA }, payload: { priceId: 'price_za_m' } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().url, 'https://checkout.stripe.test/cs_za');
      const p = calls[0];
      assert.equal(p.locale, 'en');
      assert.equal(p.line_items[0].price, 'price_za_m');
      assert.match(p.success_url, /^https:\/\/za\.lemotduchef\.fr\//);
      assert.match(p.custom_text.terms_of_service_acceptance.message, /Terms of Service and Sale.*\/terms/);
      assert.equal((await billingOf(cid)).payment_provider, 'stripe');
      // Un prix FR refusé pour une entreprise ZA (séparation des jeux de prix).
      const bad = await app.inject({ method: 'POST', url: '/api/billing/checkout',
        headers: { ...H, cookie, origin: ZA }, payload: { priceId: 'price_fr_m' } });
      assert.equal(bad.statusCode, 400);
    } finally {
      [s.customers.list, s.customers.create, s.checkout.sessions.create] = [origList, origCreate, origSess] as any;
    }
  });

  test('ZA : webhook Stripe met à jour le compte comme un compte FR', async () => {
    const cookie = await signupZa('wh@za.test');
    const cid = await makeCompany(cookie, 'Resto ZA WH');
    await pool.query(`UPDATE companies SET stripe_customer_id='cus_za_wh', payment_provider='stripe' WHERE id=$1`, [cid]);
    const ev = { id: 'evt_za_sub', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_za_1', customer: 'cus_za_wh', status: 'active',
        items: { data: [{ price: { id: 'price_za_m' }, current_period_end: 1893456000 }] },
        cancel_at_period_end: false, metadata: {} } } };
    const w = await app.inject(whStripe(ev));
    assert.equal(w.statusCode, 200);
    const b = await billingOf(cid);
    assert.equal(b.plan, 'pro'); assert.equal(b.subscription_status, 'active');
    // Résiliation → retour Gratuit, identique au marché FR.
    const del = { id: 'evt_za_del', type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_za_1', customer: 'cus_za_wh', metadata: {} } } };
    await app.inject(whStripe(del));
    const b2 = await billingOf(cid);
    assert.equal(b2.plan, 'free'); assert.equal(b2.subscription_status, 'canceled');
  });

  test('KE : checkout carte seule, locale en, prix KES', async () => {
    const cookie = await signupZa('checkout@ke.test');
    await makeCompany(cookie, 'Resto KE', false);
    await pool.query(`UPDATE companies SET market='ke' WHERE name='Resto KE'`);
    const s = stripe()!;
    const calls: any[] = [];
    const origList = s.customers.list, origCreate = s.customers.create, origSess = s.checkout.sessions.create;
    s.customers.list = async () => ({ data: [] }) as any;
    s.customers.create = async (p: any) => ({ id: 'cus_ke_1', ...p }) as any;
    s.checkout.sessions.create = async (p: any) => { calls.push(p); return { id: 'cs_ke', url: 'https://checkout.stripe.test/cs_ke' } as any; };
    try {
      const r = await app.inject({ method: 'POST', url: '/api/billing/checkout',
        headers: { ...H, cookie, origin: KE }, payload: { priceId: 'price_ke_m' } });
      assert.equal(r.statusCode, 200, r.body);
      const p = calls[0];
      assert.equal(p.locale, 'en');
      assert.equal(p.line_items[0].price, 'price_ke_m');
      assert.deepEqual(p.payment_method_types, ['card'], 'carte uniquement au Kenya');
      assert.match(p.success_url, /^https:\/\/ke\.lemotduchef\.fr\//);
      assert.match(p.custom_text.terms_of_service_acceptance.message, /Terms of Service and Sale.*\/terms/);
    } finally {
      [s.customers.list, s.customers.create, s.checkout.sessions.create] = [origList, origCreate, origSess] as any;
    }
  });

  test('CD : checkout carte seule, locale fr, prix USD, CGV', async () => {
    const cookie = await signupZa('checkout@cd.test', false);
    await makeCompany(cookie, 'Resto CD', false);
    await pool.query(`UPDATE companies SET market='cd' WHERE name='Resto CD'`);
    const s = stripe()!;
    const calls: any[] = [];
    const origList = s.customers.list, origCreate = s.customers.create, origSess = s.checkout.sessions.create;
    s.customers.list = async () => ({ data: [] }) as any;
    s.customers.create = async (p: any) => ({ id: 'cus_cd_1', ...p }) as any;
    s.checkout.sessions.create = async (p: any) => { calls.push(p); return { id: 'cs_cd', url: 'https://checkout.stripe.test/cs_cd' } as any; };
    try {
      const r = await app.inject({ method: 'POST', url: '/api/billing/checkout',
        headers: { ...H, cookie, origin: CD }, payload: { priceId: 'price_cd_m' } });
      assert.equal(r.statusCode, 200, r.body);
      const p = calls[0];
      assert.equal(p.locale, 'fr');
      assert.equal(p.line_items[0].price, 'price_cd_m');
      assert.deepEqual(p.payment_method_types, ['card'], 'carte uniquement en RDC');
      assert.match(p.success_url, /^https:\/\/cd\.lemotduchef\.fr\//);
      assert.match(p.custom_text.terms_of_service_acceptance.message, /conditions générales.*\/cgv/);
    } finally {
      [s.customers.list, s.customers.create, s.checkout.sessions.create] = [origList, origCreate, origSess] as any;
    }
  });

  test('FR : aucun changement — mêmes prix EUR, locale fr', async () => {
    const cookie = await signupZa('billing@fr.test', false);
    await makeCompany(cookie, 'Resto FR', false);
    const r = await app.inject({ method: 'GET', url: '/api/billing', headers: { ...H, cookie } });
    const b = r.json();
    assert.deepEqual(b.prices.map((p: any) => p.id).sort(), ['price_fr_m', 'price_fr_y']);
  });
});

describe('provider Paystack (préparé, non activé)', () => {

  test('webhook signé : subscription.create → pro, disable → free', async () => {
    const cookie = await signupZa('pk@za.test');
    const cid = await makeCompany(cookie, 'Resto ZA PK');
    const ev = { id: 'pk_ev_1', event: 'subscription.create',
      data: { subscription_code: 'SUB_za_1', plan_code: 'PLN_test_m',
        metadata: { company_id: cid }, customer: { customer_code: 'CUS_za' } } };
    const w = await app.inject(whPaystack(ev));
    assert.equal(w.statusCode, 200, w.body);
    const b = await billingOf(cid);
    assert.equal(b.plan, 'pro'); assert.equal(b.subscription_status, 'active');
    assert.equal(b.payment_provider, 'paystack');
    assert.equal(b.paystack_subscription_code, 'SUB_za_1');
    // Idempotence : le même event rejeté en duplicate.
    const w2 = await app.inject(whPaystack(ev));
    assert.equal(w2.json().duplicate, true);
    // Résiliation → retour Gratuit.
    const off = { id: 'pk_ev_2', event: 'subscription.disable',
      data: { subscription_code: 'SUB_za_1', metadata: {} } };
    await app.inject(whPaystack(off));
    const b2 = await billingOf(cid);
    assert.equal(b2.plan, 'free'); assert.equal(b2.subscription_status, 'canceled');
  });

  test('deux marchés ne partagent jamais le même price_id Stripe', async () => {
    const { pricesFor } = await import('../src/stripe.js');
    const { MARKET_IDS } = await import('../src/markets.js');
    const seen = new Map<string, string>();
    for (const m of MARKET_IDS)
      for (const id of Object.values(pricesFor(m)).filter(Boolean)) {
        assert.ok(!seen.has(id), `price_id ${id} partagé entre ${seen.get(id)} et ${m} — risque de facturation croisée`);
        seen.set(id, m);
      }
    assert.ok(seen.size >= 4, 'prix présents par marché');
  });

  test('webhook : signature invalide rejetée', async () => {
    const w = await app.inject({ method: 'POST', url: '/api/paystack/webhook',
      headers: { ...H, 'x-paystack-signature': 'deadbeef' }, payload: '{}' });
    assert.equal(w.statusCode, 401);
  });
});
