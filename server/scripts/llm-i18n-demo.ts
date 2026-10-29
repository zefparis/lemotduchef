// Démo réponses multilingues — PIPELINE COMPLET DE PRODUCTION :
// app.inject → /api/reviews → /generate → generateReplies (fixOpening,
// réécriture ciblée, contrôles collectifs, réinsertion du prénom).
// Affiche les 3 propositions FINALES telles que stockées, + traduction.
//   npx tsx scripts/llm-i18n-demo.ts
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env absent → variables déjà dans l'environnement */ }

const DB = 'lemotduchef_demo_i18n';
{
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`).catch(() => {});
  await admin.end();
}
process.env.DATABASE_URL = `postgres://lemotduchef:lemotduchef@127.0.0.1:5445/${DB}`;
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3530';
process.env.BETTER_AUTH_SECRET = 'demo-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.SMTP_HOST = 'log';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_GENERATE_MAX = '1000';
process.env.LLM_PROVIDER = 'anthropic'; // vrai modèle, pipeline complet

const { buildApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { outbox } = await import('../src/mailer.js');
const { CGV_VERSION } = await import('../src/legal.js');
const { config } = await import('../src/config.js');

if (!config.llm.anthropicApiKey) { console.error('ANTHROPIC_API_KEY manquante.'); process.exit(1); }

await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate();
const app = await buildApp({ retention: false });

const H = { 'content-type': 'application/json', 'x-lemotduchef-client': '1', host: 'localhost:3530' };
const cookieOf = (r: any) => (r.headers['set-cookie'] ?? []).map((c: string) => c.split(';')[0]).join('; ');
const PASSWORD = 'motdepasse1234';

// Compte FR → interface française → traductions en français sous chaque
// réponse non française (le prénom réel est réinséré partout).
const mail = [...outbox].reverse().find(m => m.to === 'demo@x.fr');
if (!mail) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H,
    payload: { email: 'demo@x.fr', password: PASSWORD, name: 'Demo', cgvAccepted: true, cgvVersion: CGV_VERSION } });
  if (r.statusCode !== 200) { console.error('signup', r.body); process.exit(1); }
}
const m2 = [...outbox].reverse().find(m => m.to === 'demo@x.fr' && /token=/.test(m.text));
const token = /token=([A-Za-z0-9._-]+)/.exec(m2?.text ?? '')?.[1];
if (token) await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}`, headers: { host: 'localhost:3530' } });
const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'demo@x.fr', password: PASSWORD } });
if (s.statusCode !== 200) { console.error('sign-in', s.body); process.exit(1); }
const cookie = cookieOf(s);

await app.inject({ method: 'POST', url: '/api/restaurants', headers: { ...H, cookie },
  payload: { name: 'Chez Marcel', city: 'Lyon', cuisine: 'bistronomie', signature_name: 'Marcel', signature_role: 'patron', tone: 'chaleureux', address_form: 'vous', avoid_phrases: [], strengths: ['la terrasse ombragée', 'le fait maison'], practical_info: 'fermé le dimanche', google_maps_url: '', google_review_url: '', contact_email: 'contact@chez-marcel.fr', contact_phone: '', show_phone: false } });

const cases = [
  { label: 'ANGLAIS', body: 'The food was excellent but we waited 45 minutes for our table despite having a reservation. The waiter was very friendly though.', rating: 3 },
  { label: 'AFRIKAANS', body: 'Die kos was heerlik maar ons het baie lank gewag vir ons etes. Die diens was vriendelik maar stadig. Ek sal nie gou terugkeer nie.', rating: 2 },
  { label: 'ALLEMAND', body: 'Das Essen war ausgezeichnet, aber die Bedienung war sehr langsam und unfreundlich. Wir mussten 40 Minuten auf unseren Tisch warten. Schade!', rating: 2 },
  { label: 'FRANÇAIS', body: 'Cuisine excellente mais service très lent ce soir : 45 minutes d\u2019attente pour les plats malgré une réservation. Personnel souriant cela dit.', rating: 3 },
];

const ONLY = process.env.ONLY ?? '';
for (const c of cases.filter(c => !ONLY || c.label === ONLY)) {
  console.log('═'.repeat(78));
  console.log(`AVIS ${c.label} — ${c.rating}/5 — « ${c.body.slice(0, 90)}… »`);
  const rv = await app.inject({ method: 'POST', url: '/api/reviews', headers: { ...H, cookie },
    payload: { author_name: 'Alex', rating: c.rating, body: c.body, source: 'manual', context_tags: [], context_note: '' } });
  if (rv.statusCode !== 201) { console.log('  avis refusé', rv.body); continue; }
  const rid = rv.json().id;
  const g = await app.inject({ method: 'POST', url: `/api/reviews/${rid}/generate`, headers: { ...H, cookie }, payload: {} });
  if (g.statusCode !== 200) { console.log('  génération échouée', g.statusCode, g.body); continue; }
  const j = g.json();
  const { rows } = await pool.query('SELECT lang FROM reviews WHERE id=$1', [rid]);
  console.log(`  langue détectée : ${rows[0]?.lang} — ${j.variants.filter((v: any) => v.text).length} propositions finales`);
  j.variants.forEach((v: any) => {
    console.log(`\n── proposition ${v.idx + 1}${v.needsReview ? ' (à relire)' : ''} — ${v.words} mots`);
    console.log(v.text || '(vide)');
    if (v.translation) console.log(`\n   ↳ Traduction : ${v.translation}`);
  });
  if (j.rejected?.length) console.log(`\n  écartées : ${j.rejected.join(' | ')}`);
  console.log();
}
await app.close(); await pool.end();
