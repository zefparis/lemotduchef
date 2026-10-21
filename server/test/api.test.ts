import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

// Base de test dédiée (créée au préalable : CREATE DATABASE lemotduchef_test).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef_test';
process.env.SIGNUP_ENABLED = 'true';
process.env.BASE_URL = 'http://localhost:3510';
process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_GENERATE_MAX = '1000';
process.env.ADMIN_EMAILS = 'admin@lemotduchef.test';
// Une origine autorisée pour vérifier que les erreurs n'écrasent jamais le CORS.
process.env.CORS_ORIGINS = 'https://lemotduchef.test';
// Driver email de test : capture en mémoire, aucun réseau.
process.env.SMTP_HOST = 'log';
process.env.MAIL_FROM = 'Le Mot du Chef Test <test@lemotduchef.local>';
// Stripe en mode test : clés factices, signature calculée localement.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_y';
// LLM mocké (aucun réseau), quota Gratuit réduit pour les tests.
process.env.LLM_PROVIDER = 'mock';
process.env.FREE_MONTHLY_REPLIES = '3';
process.env.FREE_HISTORY_DAYS = '30';
process.env.REVIEW_RETENTION_MONTHS = '12';

const { buildApp } = await import('../src/app.js');
const { migrate, pool } = await import('../src/db.js');
const { stripe } = await import('../src/stripe.js');
const { outbox } = await import('../src/mailer.js');
const { CGV_VERSION } = await import('../src/legal.js');
const { MockProvider, setLlmProvider, mockVariants } = await import('../src/llm/provider.js');
const { checkReply, wordCount, parseVariants, withSignature } = await import('../src/llm/rules.js');
const { buildUserPrompt, SYSTEM_PROMPT, PROMPT_VERSION, signatureOf } = await import('../src/llm/prompt.js');
const { computeFlags, reportGuide } = await import('../src/moderation.js');
const { purgeExpiredReviews } = await import('../src/retention.js');
const { chevaletPdf, encartPdf } = await import('../src/pdf.js');

let app: Awaited<ReturnType<typeof buildApp>>;

const H = { 'content-type': 'application/json', 'x-lemotduchef-client': '1', 'host': 'localhost:3510' };
const cookieOf = (r: any) => (r.headers['set-cookie'] ?? []).map((c: string) => c.split(';')[0]).join('; ');
const PASSWORD = 'motdepasse1234'; // ≥ 12 caractères

const lastMailTo = (email: string, subjectMatch: RegExp) =>
  [...outbox].reverse().find(m => m.to === email && subjectMatch.test(m.subject));
const tokenFrom = (mail: { text: string }) => /token=([A-Za-z0-9._-]+)/.exec(mail.text)?.[1];

async function signupRaw(email: string, name = 'Test') {
  return app.inject({
    method: 'POST', url: '/api/auth/sign-up/email', headers: H,
    payload: { email, password: PASSWORD, name, cgvAccepted: true, cgvVersion: CGV_VERSION },
  });
}

// Inscription complète : signup → email de vérification capturé → vérification → session.
async function signup(email: string, name = 'Test') {
  const r = await signupRaw(email, name);
  assert.equal(r.statusCode, 200, `signup ${email} : ${r.body}`);
  const mail = lastMailTo(email, /confirmez votre email/i);
  assert.ok(mail, `email de vérification envoyé à ${email}`);
  const token = tokenFrom(mail!);
  assert.ok(token, 'token de vérification présent');
  const v = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=${token}`, headers: { host: 'localhost:3510' } });
  assert.ok([200, 302].includes(v.statusCode), `verify-email → ${v.statusCode}`);
  const cookie = cookieOf(v);
  if (cookie.includes('session_token')) return cookie;
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email, password: PASSWORD } });
  assert.equal(s.statusCode, 200, `sign-in ${email}`);
  return cookieOf(s);
}

const PROFILE = {
  name: 'La Table d’Aurore', city: 'Lyon', cuisine: 'bistronomie',
  signature_name: 'Marc', signature_role: 'chef et propriétaire', tone: 'chaleureux',
  strengths: ['fait maison', 'produits locaux', 'terrasse ombragée'],
  practical_info: 'Réservation conseillée le week-end',
  google_maps_url: 'https://maps.app.goo.gl/abc123', google_review_url: 'https://g.page/r/CaXyZ/review',
  contact_email: 'contact@tabledaurore.fr', contact_phone: '04 78 00 00 00',
};
async function createRestaurant(cookie: string, over: any = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/restaurants', headers: { ...H, cookie }, payload: { ...PROFILE, ...over } });
  assert.equal(r.statusCode, 201, `restaurant : ${r.body}`);
  return r.json().id as string;
}
async function addReview(cookie: string, over: any = {}) {
  const r = await app.inject({
    method: 'POST', url: '/api/reviews', headers: { ...H, cookie },
    payload: { author_name: 'Julie', rating: 5, body: 'Le risotto aux cèpes était divin et le serveur Thomas adorable. Terrasse très agréable.', visited_on: '2026-10-10', ...over },
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.json()));
  return r.json();
}
async function generate(cookie: string, id: string) {
  return app.inject({ method: 'POST', url: `/api/reviews/${id}/generate`, headers: { ...H, cookie }, payload: {} });
}
async function makePro(companyId: string, customer = 'cus_' + companyId.slice(0, 8)) {
  await pool.query(`UPDATE companies SET plan='pro', subscription_status='active', stripe_customer_id=$2 WHERE id=$1`, [companyId, customer]);
}

before(async () => {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  app = await buildApp({ retention: false });
});
after(async () => { await app.close(); await pool.end(); });

/* ====================== Socle ====================== */
test('health + config publique', async () => {
  const h = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(h.statusCode, 200);
  const c = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(c.json().signupEnabled, true);
  assert.equal(c.json().freeMonthlyReplies, 3);
  assert.deepEqual(c.json().sources, ['manual']);
  assert.ok(c.json().contextTags.health);
});

test('schéma : plus aucune table « devis »', async () => {
  const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
  const names = rows.map(r => r.tablename);
  for (const t of ['quotes', 'followups', 'company_settings']) assert.ok(!names.includes(t), `${t} supprimée`);
  for (const t of ['restaurant_profiles', 'reviews', 'generations', 'reply_variants', 'collect_settings']) assert.ok(names.includes(t), `${t} présente`);
});

test('accès refusé sans session', async () => {
  for (const url of ['/api/reviews', '/api/restaurant', '/api/me', '/api/export-data', '/api/collect', '/api/usage']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 401, url);
  }
});

test('mutation refusée sans en-tête client (CSRF) ; origine étrangère refusée', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/reviews', headers: { 'content-type': 'application/json' }, payload: {} });
  assert.equal(r.statusCode, 403);
  const o = await app.inject({ method: 'POST', url: '/api/reviews', headers: { ...H, origin: 'https://evil.example' }, payload: {} });
  assert.equal(o.statusCode, 403);
});

test('signup envoie un email de vérification ; connexion bloquée tant que non vérifié', async () => {
  const r = await signupRaw('nonverifie@x.fr');
  assert.equal(r.statusCode, 200);
  assert.ok(lastMailTo('nonverifie@x.fr', /confirmez/i));
  assert.match(lastMailTo('nonverifie@x.fr', /confirmez/i)!.text, /Le Mot du Chef/);
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'nonverifie@x.fr', password: PASSWORD } });
  assert.equal(s.statusCode, 403);
});

test('signup → vérification → onboarding restaurant → me, puis logout', async () => {
  const cookie = await signup('a@x.fr');
  const me0 = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me0.json().restaurant, null);
  const r = await app.inject({ method: 'GET', url: '/api/reviews', headers: { cookie } });
  assert.equal(r.statusCode, 409, 'sans restaurant → NO_COMPANY');
  await createRestaurant(cookie);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().restaurant.name, 'La Table d’Aurore');
  assert.equal(me.json().restaurant.onboarded, true);
  const dup = await app.inject({ method: 'POST', url: '/api/restaurants', headers: { ...H, cookie }, payload: PROFILE });
  assert.equal(dup.statusCode, 409);
  const out = await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { ...H, cookie }, payload: {} });
  assert.equal(out.statusCode, 200);
  const me2 = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me2.statusCode, 401);
});

test('mauvais mot de passe → erreur générique', async () => {
  await signup('b@x.fr');
  const r = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'b@x.fr', password: 'faux-faux-faux' } });
  assert.ok([401, 403].includes(r.statusCode));
  assert.ok(!/exist|trouv/i.test(r.body));
});

test('mot de passe oublié : email → lien → nouveau mot de passe (usage unique)', async () => {
  await signup('reset@x.fr');
  const f = await app.inject({ method: 'POST', url: '/api/auth/request-password-reset', headers: H, payload: { email: 'reset@x.fr' } });
  assert.equal(f.statusCode, 200);
  const mail = lastMailTo('reset@x.fr', /réinitialisation/i);
  assert.ok(mail);
  const token = tokenFrom(mail!)!;
  const r = await app.inject({ method: 'POST', url: '/api/auth/reset-password', headers: H, payload: { newPassword: 'nouveaumotdepasse', token } });
  assert.ok(r.statusCode < 300, `reset → ${r.statusCode} ${r.body}`);
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'reset@x.fr', password: 'nouveaumotdepasse' } });
  assert.equal(s.statusCode, 200);
  const r2 = await app.inject({ method: 'POST', url: '/api/auth/reset-password', headers: H, payload: { newPassword: 'encoreautre1234', token } });
  assert.ok(r2.statusCode >= 400, 'token réutilisé refusé');
});

/* ====================== Profil restaurant ====================== */
test('profil : validation (liens Google, email, ton) et mise à jour', async () => {
  const cookie = await signup('p@x.fr');
  const bad = await app.inject({ method: 'POST', url: '/api/restaurants', headers: { ...H, cookie }, payload: { ...PROFILE, google_review_url: 'https://evil.example/review' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /laisser un avis/i);
  const badTone = await app.inject({ method: 'POST', url: '/api/restaurants', headers: { ...H, cookie }, payload: { ...PROFILE, tone: 'agressif' } });
  assert.equal(badTone.statusCode, 400);
  await createRestaurant(cookie);
  const upd = await app.inject({ method: 'PATCH', url: '/api/restaurant', headers: { ...H, cookie }, payload: { ...PROFILE, city: 'Villeurbanne', strengths: ['fait maison'], tone: 'elegant' } });
  assert.equal(upd.statusCode, 200, upd.body);
  const got = await app.inject({ method: 'GET', url: '/api/restaurant', headers: { cookie } });
  assert.equal(got.json().city, 'Villeurbanne');
  assert.equal(got.json().tone, 'elegant');
  assert.deepEqual(got.json().strengths, ['fait maison']);
  const badMail = await app.inject({ method: 'PATCH', url: '/api/restaurant', headers: { ...H, cookie }, payload: { ...PROFILE, contact_email: 'pas-un-email' } });
  assert.equal(badMail.statusCode, 400);
});

/* ====================== Avis : CRUD, suspicion, signalement ====================== */
test('avis : création, validation, lecture, modification, suppression', async () => {
  const cookie = await signup('c@x.fr'); await createRestaurant(cookie);
  const bad = await app.inject({ method: 'POST', url: '/api/reviews', headers: { ...H, cookie }, payload: { rating: 9, body: 'x' } });
  assert.equal(bad.statusCode, 400);
  const { id, flags } = await addReview(cookie);
  assert.deepEqual(flags, []);
  const list = await app.inject({ method: 'GET', url: '/api/reviews', headers: { cookie } });
  assert.equal(list.json().reviews.length, 1);
  assert.equal(list.json().historyLimitedDays, 30, 'Gratuit : historique borné');
  const one = await app.inject({ method: 'GET', url: `/api/reviews/${id}`, headers: { cookie } });
  assert.equal(one.json().review.author_name, 'Julie');
  assert.equal(one.json().report.suspicious, false);
  // Contexte ignoré sur un avis positif, conservé sur un avis négatif.
  const patch = await app.inject({ method: 'PATCH', url: `/api/reviews/${id}`, headers: { ...H, cookie },
    payload: { author_name: 'Julie', rating: 2, body: 'Attente interminable, plat froid.', context_tags: ['full_house', 'bidon'], context_note: 'Samedi soir complet' } });
  assert.equal(patch.statusCode, 200, patch.body);
  const two = await app.inject({ method: 'GET', url: `/api/reviews/${id}`, headers: { cookie } });
  assert.deepEqual(two.json().review.context_tags, ['full_house']);
  const search = await app.inject({ method: 'GET', url: '/api/reviews?search=froid', headers: { cookie } });
  assert.equal(search.json().reviews.length, 1);
  const del = await app.inject({ method: 'DELETE', url: `/api/reviews/${id}`, headers: { 'x-lemotduchef-client': '1', cookie } });
  assert.equal(del.statusCode, 200);
  const gone = await app.inject({ method: 'GET', url: `/api/reviews/${id}`, headers: { cookie } });
  assert.equal(gone.statusCode, 404);
});

test('avis suspect : indicateurs et guide de signalement honnête', async () => {
  assert.deepEqual(computeFlags({ rating: 1, body: '', context_tags: [] }), ['no_text_low_rating']);
  assert.ok(computeFlags({ rating: 1, body: 'Mon colis Amazon est arrivé en retard et le livreur était impoli, je suis furieux contre cette entreprise de transport.', context_tags: [] }).includes('off_topic'));
  assert.ok(computeFlags({ rating: 1, body: 'Je me suis trompé, ce n’est pas le bon restaurant mais le service était nul.', context_tags: [] }).includes('other_business'));
  assert.ok(computeFlags({ rating: 1, body: 'Le patron est un connard et le plat était froid.', context_tags: [] }).includes('insults'));
  assert.ok(computeFlags({ rating: 1, body: 'Ce sont des escrocs, le plat était froid.', context_tags: [] }).includes('defamatory'));
  assert.ok(computeFlags({ rating: 2, body: 'Allez plutôt chez nous, code promo RESTO10 sur www.monsite.com, le service ici est lent.', context_tags: [] }).includes('spam'));
  assert.ok(computeFlags({ rating: 2, body: 'Service lent.', context_tags: ['unknown_customer'] }).includes('unknown_customer'));
  assert.deepEqual(computeFlags({ rating: 5, body: 'Super service, plats délicieux.', context_tags: [] }), []);

  const g = reportGuide(['insults', 'unknown_customer'], 'Chez Test');
  assert.equal(g.suspicious, true);
  assert.equal(g.reason, 'discrimination_hate');
  assert.match(g.text!, /Chez Test/);
  assert.match(g.notice, /ne retire que les avis contraires à ses règles/i);
  assert.match(g.helpUrl, /^https:\/\/support\.google\.com\//);
  const none = reportGuide([], 'Chez Test');
  assert.equal(none.suspicious, false);
  assert.equal(none.text, null);

  const cookie = await signup('sus@x.fr'); await createRestaurant(cookie);
  const r = await addReview(cookie, { rating: 1, body: '', author_name: 'X', context_tags: ['unknown_customer'] });
  assert.ok(r.flags.includes('no_text_low_rating') && r.flags.includes('unknown_customer'));
  assert.equal(r.report.suspicious, true);
  const flagged = await app.inject({ method: 'GET', url: '/api/reviews?status=flagged', headers: { cookie } });
  assert.equal(flagged.json().reviews.length, 1);
});

/* ====================== Règles du rédacteur (LLM mocké) ====================== */
const RULE_PROFILE = { ...PROFILE, tone: 'chaleureux' as const };
const POSITIVE = { author_name: 'Julie', rating: 5, body: 'Risotto divin, serveur adorable.', visited_on: null, context_tags: [], context_note: '' };
const NEGATIVE = { author_name: 'Paul', rating: 1, body: 'Attente d’une heure, plat froid à plusieurs reprises, personnel désagréable, service lent et aucune excuse présentée.', visited_on: null, context_tags: ['full_house'], context_note: '' };
const HEALTH = { ...NEGATIVE, body: 'J’ai été malade toute la nuit après votre plat, intoxication alimentaire évidente.', context_tags: ['health'] };
const sig = signatureOf(RULE_PROFILE);
const words = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');

test('prompt système versionné : règles clés présentes', () => {
  assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  for (const re of [/FUTURS clients/, /vouvoyant/, /jamais accuser l'auteur de mentir/i, /information personnelle/i, /judiciaire/, /allergie, intoxication/, /UN point fort/, /AU PLUS une fois/, /vise environ 45 mots/, /vise environ 80 mots/, /3 variantes/, /aucun point fort/i])
    assert.match(SYSTEM_PROMPT, re);
  const u = buildUserPrompt(RULE_PROFILE as any, NEGATIVE as any, ['Merci pour votre retour.']);
  assert.match(u, /Signature : Marc, chef et propriétaire/);
  assert.match(u, /Service complet, attente annoncée/);
  assert.match(u, /FORMULATIONS À ÉVITER/);
  assert.match(u, /<<<AVIS\n.*plat froid/s);
  assert.equal(signatureOf({ signature_name: '', signature_role: '', name: 'Chez X' }), 'Chez X');
});

test('règles : longueur, signature, nom/ville, interdits, données personnelles, santé', () => {
  const okPos = `Bonjour Julie, merci pour ce retour. ${words(35)} Au plaisir de vous revoir chez La Table d’Aurore.\n${sig}`;
  assert.equal(checkReply(okPos, RULE_PROFILE as any, POSITIVE as any).ok, true);
  // Trop court / trop long.
  assert.match(checkReply(`Merci.\n${sig}`, RULE_PROFILE as any, POSITIVE as any).errors.join(), /trop court/);
  assert.match(checkReply(`${words(120)}\n${sig}`, RULE_PROFILE as any, POSITIVE as any).errors.join(), /trop long/);
  assert.match(checkReply(`Bonjour Paul, ${words(30)}\n${sig}`, RULE_PROFILE as any, NEGATIVE as any).errors.join(), /trop court/);
  // Signature absente.
  assert.match(checkReply(`Bonjour Julie, ${words(40)}\nL’équipe`, RULE_PROFILE as any, POSITIVE as any).errors.join(), /signature absente/);
  // Nom du restaurant répété, ville répétée.
  assert.match(checkReply(`La Table d’Aurore vous remercie. ${words(30)} Revenez vite à La Table d’Aurore.\n${sig}`, RULE_PROFILE as any, POSITIVE as any).errors.join(), /nom du restaurant répété/);
  assert.match(checkReply(`À Lyon, ${words(30)} tout Lyon le sait.\n${sig}`, RULE_PROFILE as any, POSITIVE as any).errors.join(), /ville répétée/);
  // Interdits : accusation de mensonge, menace judiciaire, tutoiement, emoji.
  for (const [frag, re] of [['vous mentez', /juridique|mensonge/], ['notre avocat', /juridique/], ['tu exagères', /tutoiement/], ['merci 😀', /emoji/]] as const)
    assert.match(checkReply(`Bonjour Paul, ${frag}. ${words(55)}\n${sig}`, RULE_PROFILE as any, NEGATIVE as any).errors.join(), re);
  // Coordonnées : email du profil autorisé ; téléphone seulement si l'option est
  // activée ; tout autre email/téléphone refusé.
  assert.equal(checkReply(`Bonjour Paul, écrivez-nous à contact@tabledaurore.fr. ${words(50)}\n${sig}`, RULE_PROFILE as any, NEGATIVE as any).ok, true);
  assert.match(checkReply(`Bonjour Paul, écrivez-nous ou appelez le 04 78 00 00 00. ${words(50)}\n${sig}`, RULE_PROFILE as any, NEGATIVE as any).errors.join(), /téléphone/);
  assert.equal(checkReply(`Bonjour Paul, écrivez-nous ou appelez le 04 78 00 00 00. ${words(50)}\n${sig}`, { ...RULE_PROFILE, show_phone: true } as any, NEGATIVE as any).ok, true);
  assert.match(checkReply(`Bonjour Paul, écrivez à paul.durand@gmail.com. ${words(50)}\n${sig}`, RULE_PROFILE as any, NEGATIVE as any).errors.join(), /email étranger/);
  assert.match(checkReply(`Bonjour Paul, rappelez-nous au 06 12 34 56 78. ${words(50)}\n${sig}`, { ...RULE_PROFILE, show_phone: true } as any, NEGATIVE as any).errors.join(), /téléphone étranger/);
  // Santé : aucune reconnaissance de responsabilité, invitation au contact obligatoire.
  assert.match(checkReply(`Bonjour Paul, c’est de notre faute, nous reconnaissons le problème, contactez-nous. ${words(50)}\n${sig}`, RULE_PROFILE as any, HEALTH as any).errors.join(), /responsabilité/);
  assert.match(checkReply(`Bonjour Paul, cela nous touche. ${words(55)}\n${sig}`, RULE_PROFILE as any, HEALTH as any).errors.join(), /contact privé/);
  assert.equal(checkReply(`Bonjour Paul, nous comprenons votre inquiétude et vous invitons à nous contacter directement. ${words(35)}\n${sig}`, RULE_PROFILE as any, HEALTH as any).ok, true);
  // Avertissement (non bloquant) : geste commercial sur un avis négatif.
  const w = checkReply(`Bonjour Paul, nous vous offrons un verre. ${words(55)}\n${sig}`, RULE_PROFILE as any, NEGATIVE as any);
  assert.equal(w.ok, true); assert.match(w.warnings.join(), /geste commercial/);
  assert.equal(wordCount('Bonjour, l’équipe vous remercie !'), 4);
  assert.deepEqual(parseVariants('```json\n{"variants":["a","b"]}\n```'), ['a', 'b']);
  assert.deepEqual(parseVariants('rien'), []);
});

test('mock : les variantes produites respectent les règles (positif, négatif, santé)', () => {
  for (const r of [POSITIVE, NEGATIVE, HEALTH]) {
    const vs = parseVariants(mockVariants(buildUserPrompt(RULE_PROFILE as any, r as any, [])));
    assert.equal(vs.length, 3);
    for (const v of vs) {
      // Le modèle n'écrit pas de signature : le code l'ajoute (comme generate.ts).
      const c = checkReply(withSignature(v, sig), RULE_PROFILE as any, r as any);
      assert.ok(c.ok, `note ${r.rating} : ${c.errors.join(', ')}\n${v}`);
    }
  }
});

test('génération : 3 variantes, journalisation des tokens, variante non conforme écartée, anti-répétition', async () => {
  const cookie = await signup('gen@x.fr'); const cid = await createRestaurant(cookie);
  await makePro(cid);
  const { id } = await addReview(cookie);
  const r = await generate(cookie, id);
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.variants.length, 3);
  assert.ok(j.variants.every((v: any) => v.text.includes(sig)), 'signature dans chaque variante');
  assert.ok(j.usage.inputTokens > 0 && j.usage.outputTokens > 0);
  assert.equal(j.quota.remaining, null, 'Pro : pas de quota');
  const { rows: g } = await pool.query('SELECT provider, model, prompt_version, input_tokens, output_tokens FROM generations WHERE review_id=$1', [id]);
  assert.equal(g.length, 1);
  assert.equal(g[0].provider, 'mock');
  assert.equal(g[0].prompt_version, PROMPT_VERSION);
  assert.ok(g[0].input_tokens > 0);
  const one = await app.inject({ method: 'GET', url: `/api/reviews/${id}`, headers: { cookie } });
  assert.equal(one.json().variants.length, 3);

  // Le modèle renvoie une variante tutoyante + une fuite d'email + une bonne :
  // la bonne passe, les autres reviennent marquées « à revoir ».
  let calls = 0;
  setLlmProvider(new MockProvider(req => {
    calls++;
    const good = parseVariants(mockVariants(req.user))[0];
    const bad1 = good.replace('Bonjour Julie,', 'Salut Julie, tu');
    const bad2 = good.replace('Bonjour Julie,', 'Bonjour Julie (julie.martin@gmail.com),');
    return JSON.stringify({ variants: [bad1, bad2, good] });
  }));
  try {
    const r2 = await generate(cookie, id);
    assert.equal(r2.statusCode, 200, r2.body);
    assert.equal(r2.json().variants.filter((v: any) => !v.needsReview).length, 1, 'une seule variante conforme');
    assert.equal(r2.json().variants.filter((v: any) => v.needsReview).length, 2, 'positions écartées marquées à revoir');
    assert.ok(r2.json().rejected.some((x: string) => /tutoiement/.test(x)));
    assert.ok(r2.json().rejected.some((x: string) => /email étranger/.test(x)));
    assert.equal(calls, 2, 'seconde tentative pour compléter');
    // Aucune variante conforme → 502 propre, sans décompte du quota.
    setLlmProvider(new MockProvider(() => 'pas du json'));
    const r3 = await generate(cookie, id);
    assert.equal(r3.statusCode, 502);
    assert.equal(r3.json().code, 'LLM_FORMAT');
    const { rows: g2 } = await pool.query('SELECT count(*) AS n FROM generations WHERE review_id=$1', [id]);
    assert.equal(Number(g2[0].n), 2, 'l’échec total ne consomme pas le quota');
    // Anti-répétition : les réponses précédentes sont transmises comme « à éviter ».
    let seen = '';
    setLlmProvider(new MockProvider(req => { seen = req.user; return mockVariants(req.user); }));
    await app.inject({ method: 'POST', url: `/api/reviews/${id}/publish`, headers: { ...H, cookie }, payload: { text: 'Bonjour Julie, merci pour ce retour chaleureux. Au plaisir.\n' + sig } });
    const { id: id2 } = await addReview(cookie, { author_name: 'Nina' });
    await generate(cookie, id2);
    assert.match(seen, /FORMULATIONS À ÉVITER/);
    assert.match(seen, /merci pour ce retour chaleureux/);
  } finally { setLlmProvider(null); }
});

test('génération : erreurs LLM propres (timeout, upstream) et profil requis', async () => {
  const cookie = await signup('err@x.fr'); const cid = await createRestaurant(cookie);
  await makePro(cid);
  const { id } = await addReview(cookie);
  const { LlmError } = await import('../src/llm/provider.js');
  setLlmProvider({ name: 'mock', complete: async () => { throw new LlmError('Le rédacteur met trop de temps à répondre.', 'timeout'); } });
  try {
    const r = await generate(cookie, id);
    assert.equal(r.statusCode, 504);
    assert.equal(r.json().code, 'LLM_TIMEOUT');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  } finally { setLlmProvider(null); }
  const { rows } = await pool.query('SELECT count(*) AS n FROM generations WHERE review_id=$1', [id]);
  assert.equal(Number(rows[0].n), 0, 'aucun quota consommé sur échec réseau');
});

test('génération : erreur LLM → 502 propre avec CORS conservés', async () => {
  const cookie = await signup('cors502@x.fr'); const cid = await createRestaurant(cookie);
  await makePro(cid);
  const { id } = await addReview(cookie);
  const { LlmError } = await import('../src/llm/provider.js');
  setLlmProvider({ name: 'mock', complete: async () => { throw new LlmError('Fournisseur LLM en erreur (400).', 'upstream'); } });
  try {
    const r = await app.inject({ method: 'POST', url: `/api/reviews/${id}/generate`,
      headers: { ...H, cookie, origin: 'https://lemotduchef.test' }, payload: {} });
    assert.equal(r.statusCode, 502, r.body);
    assert.equal(r.headers['access-control-allow-origin'], 'https://lemotduchef.test',
      'l’erreur passe par Fastify : l’en-tête CORS doit être présent');
    assert.equal(r.json().error, 'La génération est momentanément indisponible, réessayez dans un instant.');
    assert.equal(r.json().code, 'LLM_UPSTREAM');
    assert.ok(!/400|anthropic|api/i.test(r.json().error), 'aucun détail technique au client');
  } finally { setLlmProvider(null); }
});

test('LLM : requête sans temperature/top_p/top_k, thinking désactivé, sortie par outil', async () => {
  const { AnthropicProvider } = await import('../src/llm/provider.js');
  const { config } = await import('../src/config.js');
  let sent: Record<string, unknown> = {};
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({
      content: [{ type: 'tool_use', name: 'submit_replies', input: { variants: ['a', 'b', 'c'] } }],
      usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-haiku-5-5', stop_reason: 'tool_use',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let res: any;
  try {
    (config.llm as any).anthropicApiKey = 'test-key';
    res = await new AnthropicProvider().complete(
      { system: 'système', user: 'utilisateur', maxTokens: 64 }, new AbortController().signal);
  } finally {
    (globalThis as any).fetch = orig;
    (config.llm as any).anthropicApiKey = '';
  }
  assert.equal(res.model, 'claude-haiku-5-5');
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(JSON.parse(res.text), { variants: ['a', 'b', 'c'] });
  assert.ok(Object.keys(sent).length, 'corps de requête capturé');
  assert.equal('temperature' in sent, false);
  assert.equal('top_p' in sent, false);
  assert.equal('top_k' in sent, false);
  assert.deepEqual(sent.thinking, { type: 'disabled' }, 'réflexion désactivée explicitement');
  assert.ok(Array.isArray(sent.tools), 'sortie structurée par outil');
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'submit_replies' });
  assert.ok(sent.system && Array.isArray(sent.messages) && sent.max_tokens === 64);
});

/* ====================== Quotas serveur ====================== */
test('quota Gratuit : N générations/mois → PLAN_LIMIT ; Pro illimité ; résiliation → retour Gratuit', async () => {
  const cookie = await signup('quota@x.fr'); const cid = await createRestaurant(cookie);
  const { id } = await addReview(cookie);
  const u0 = await app.inject({ method: 'GET', url: '/api/usage', headers: { cookie } });
  assert.deepEqual([u0.json().plan, u0.json().remaining, u0.json().limit], ['free', 3, 3]);
  for (let i = 0; i < 3; i++) {
    const r = await generate(cookie, id);
    assert.equal(r.statusCode, 200, `génération ${i + 1} : ${r.body}`);
    assert.equal(r.json().quota.remaining, 2 - i);
  }
  const over = await generate(cookie, id);
  assert.equal(over.statusCode, 403);
  assert.equal(over.json().code, 'PLAN_LIMIT');
  const b = await app.inject({ method: 'GET', url: '/api/billing', headers: { cookie } });
  assert.deepEqual(b.json().usage, { used: 3, limit: 3 });
  // La saisie d'avis reste libre : seul le rédacteur est contingenté.
  await addReview(cookie, { author_name: 'Zoé' });

  // Passage Pro via webhook signé → limite levée.
  await pool.query('UPDATE companies SET stripe_customer_id=$1 WHERE id=$2', ['cus_quota', cid]);
  const sub = { id: 'sub_quota', customer: 'cus_quota', status: 'active', cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: {}, items: { data: [{ price: { id: 'price_pro_m' } }] } };
  const ev = { id: 'evt_sub_quota_1', type: 'customer.subscription.updated', data: { object: sub } };
  const w1 = await app.inject({ method: 'POST', url: '/api/stripe/webhook', ...whReq(ev) });
  assert.equal(w1.statusCode, 200, w1.body);
  const w2 = await app.inject({ method: 'POST', url: '/api/stripe/webhook', ...whReq(ev) });
  assert.equal(w2.json().duplicate, true, 'webhook idempotent');
  const ok = await generate(cookie, id);
  assert.equal(ok.statusCode, 200, 'Pro : limite levée');
  assert.equal(ok.json().quota.remaining, null);
  // past_due : accès conservé.
  await app.inject({ method: 'POST', url: '/api/stripe/webhook', ...whReq({ id: 'evt_fail_1', type: 'invoice.payment_failed', data: { object: { customer: 'cus_quota' } } }) });
  assert.equal((await generate(cookie, id)).statusCode, 200);
  // Résiliation : retour Gratuit, quota du mois déjà consommé → bloqué, données conservées.
  await app.inject({ method: 'POST', url: '/api/stripe/webhook', ...whReq({ id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: { id: 'sub_quota', customer: 'cus_quota', metadata: {} } } }) });
  const blocked = await generate(cookie, id);
  assert.equal(blocked.statusCode, 403);
  const { rows } = await pool.query('SELECT count(*) AS n FROM reviews WHERE company_id=$1', [cid]);
  assert.equal(Number(rows[0].n), 2);
  const { rows: v } = await pool.query('SELECT count(*) AS n FROM reply_variants WHERE company_id=$1', [cid]);
  assert.ok(Number(v[0].n) >= 15, 'variantes conservées');
});

test('quota : le mois précédent ne compte pas', async () => {
  const cookie = await signup('month@x.fr'); const cid = await createRestaurant(cookie);
  const { id } = await addReview(cookie);
  for (let i = 0; i < 3; i++) assert.equal((await generate(cookie, id)).statusCode, 200);
  assert.equal((await generate(cookie, id)).statusCode, 403);
  await pool.query(`UPDATE generations SET created_at = created_at - interval '40 days' WHERE company_id=$1`, [cid]);
  assert.equal((await generate(cookie, id)).statusCode, 200, 'nouveau mois : quota réinitialisé');
});

/* ====================== Isolation ====================== */
test('isolation entre restaurants (id manipulé → 404, listes disjointes)', async () => {
  const cA = await signup('iso-a@x.fr'); const cidA = await createRestaurant(cA, { name: 'Iso A' });
  const cB = await signup('iso-b@x.fr'); await createRestaurant(cB, { name: 'Iso B' });
  await makePro(cidA);
  const { id } = await addReview(cA, { author_name: 'Secret A', body: 'Texte confidentiel du restaurant A, plat parfait.' });
  await generate(cA, id);
  for (const [m, p] of [['GET', `/api/reviews/${id}`], ['PATCH', `/api/reviews/${id}`], ['DELETE', `/api/reviews/${id}`],
    ['POST', `/api/reviews/${id}/generate`], ['POST', `/api/reviews/${id}/publish`]] as const) {
    const r = await app.inject({ method: m, url: p, headers: { ...H, cookie: cB },
      payload: m === 'GET' ? undefined : { author_name: 'x', rating: 1, body: 'hack', text: 'hack' } });
    assert.equal(r.statusCode, 404, `${m} ${p} → ${r.statusCode}`);
  }
  const list = await app.inject({ method: 'GET', url: '/api/reviews?search=confidentiel', headers: { cookie: cB } });
  assert.equal(list.json().reviews.length, 0);
  assert.equal(list.json().total, 0);
  const gB = await app.inject({ method: 'GET', url: '/api/restaurant', headers: { cookie: cB } });
  assert.equal(gB.json().name, 'Iso B');
  const exp = await app.inject({ method: 'GET', url: '/api/export-data', headers: { cookie: cB } });
  assert.ok(!exp.body.includes('Secret A') && !exp.body.includes('confidentiel'));
  // Les variantes de A ne servent jamais de « phrases à éviter » à B.
  let seen = '';
  setLlmProvider(new MockProvider(req => { seen = req.user; return mockVariants(req.user); }));
  try {
    const { id: idB } = await addReview(cB);
    await generate(cB, idB);
    assert.ok(!/FORMULATIONS À ÉVITER/.test(seen), 'B n’a aucun historique');
  } finally { setLlmProvider(null); }
});

/* ====================== Publication ====================== */
test('publication : texte final enregistré, annulable, historique filtrable', async () => {
  const cookie = await signup('pub@x.fr'); await createRestaurant(cookie);
  const { id } = await addReview(cookie);
  const bad = await app.inject({ method: 'POST', url: `/api/reviews/${id}/publish`, headers: { ...H, cookie }, payload: { text: '' } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: `/api/reviews/${id}/publish`, headers: { ...H, cookie }, payload: { text: 'Merci Julie, à bientôt.\n' + sig } });
  assert.equal(ok.statusCode, 200);
  const pub = await app.inject({ method: 'GET', url: '/api/reviews?status=published', headers: { cookie } });
  assert.equal(pub.json().reviews.length, 1);
  assert.ok(pub.json().reviews[0].published_at);
  const un = await app.inject({ method: 'POST', url: `/api/reviews/${id}/publish`, headers: { ...H, cookie }, payload: { published: false } });
  assert.equal(un.json().published, false);
  const pend = await app.inject({ method: 'GET', url: '/api/reviews?status=pending', headers: { cookie } });
  assert.equal(pend.json().reviews.length, 1);
});

/* ====================== Historique Gratuit vs Pro ====================== */
test('historique : Gratuit limité à FREE_HISTORY_DAYS, Pro complet', async () => {
  const cookie = await signup('hist@x.fr'); const cid = await createRestaurant(cookie);
  const { id: old } = await addReview(cookie, { author_name: 'Ancien' });
  await addReview(cookie, { author_name: 'Récent' });
  await pool.query(`UPDATE reviews SET created_at = now() - interval '45 days' WHERE id=$1`, [old]);
  const free = await app.inject({ method: 'GET', url: '/api/reviews', headers: { cookie } });
  assert.equal(free.json().reviews.length, 1);
  assert.equal(free.json().total, 2, 'rien n’est supprimé');
  await makePro(cid);
  const pro = await app.inject({ method: 'GET', url: '/api/reviews', headers: { cookie } });
  assert.equal(pro.json().reviews.length, 2);
  assert.equal(pro.json().historyLimitedDays, null);
});

/* ====================== Collecte d'avis : QR + PDF ====================== */
test('collecte : réglages, refus de contrepartie, QR pour tous, PDF réservés Pro et valides', async () => {
  const cookie = await signup('pdf@x.fr'); const cid = await createRestaurant(cookie, { google_review_url: '' });
  const c0 = await app.inject({ method: 'GET', url: '/api/collect', headers: { cookie } });
  assert.equal(c0.statusCode, 200);
  assert.match(c0.json().pledge, /tous vos clients/i);
  assert.ok(c0.json().helpSteps.length >= 3);
  const noLink = await app.inject({ method: 'GET', url: '/api/collect/qr.png', headers: { cookie } });
  assert.equal(noLink.statusCode, 409);
  assert.equal(noLink.json().code, 'NO_REVIEW_URL');
  await app.inject({ method: 'PATCH', url: '/api/restaurant', headers: { ...H, cookie }, payload: PROFILE });
  const bribe = await app.inject({ method: 'PATCH', url: '/api/collect', headers: { ...H, cookie }, payload: { title: 'Un avis = un café offert', message: '' } });
  assert.equal(bribe.statusCode, 400, 'contrepartie refusée');
  const ok = await app.inject({ method: 'PATCH', url: '/api/collect', headers: { ...H, cookie }, payload: { title: 'Votre avis compte', message: 'Merci de votre visite — à bientôt chez nous !' } });
  assert.equal(ok.statusCode, 200);
  const qr = await app.inject({ method: 'GET', url: '/api/collect/qr.png', headers: { cookie } });
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.equal(qr.rawPayload.subarray(1, 4).toString(), 'PNG');
  const free = await app.inject({ method: 'GET', url: '/api/collect/chevalet.pdf', headers: { cookie } });
  assert.equal(free.statusCode, 403);
  assert.equal(free.json().code, 'PLAN_LIMIT');
  await makePro(cid);
  for (const kind of ['chevalet', 'encart']) {
    const pdf = await app.inject({ method: 'GET', url: `/api/collect/${kind}.pdf`, headers: { cookie } });
    assert.equal(pdf.statusCode, 200, kind);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.rawPayload.length > 2000, `${kind} : contenu non vide`);
  }
  // Rendu direct : titres accentués, caractères non encodables ignorés sans erreur.
  const bytes = await encartPdf({ restaurant: 'Chez Émile & Cœur 😀', title: 'Votre avis compte', message: 'Merci — à bientôt !', reviewUrl: 'https://g.page/r/x/review' });
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  const ch = await chevaletPdf({ restaurant: 'Test', title: 'T', message: 'M', reviewUrl: 'https://g.page/r/x/review' });
  assert.ok(ch.length > 1000);
});

/* ====================== Purge RGPD ====================== */
test('purge RGPD : texte, prénom et variantes effacés après la durée de conservation ; note et réponse conservées', async () => {
  const cookie = await signup('rgpd@x.fr'); const cid = await createRestaurant(cookie);
  await makePro(cid);
  const { id: old } = await addReview(cookie, { author_name: 'Ancienne' });
  const { id: fresh } = await addReview(cookie, { author_name: 'Fraîche' });
  await generate(cookie, old);
  await app.inject({ method: 'POST', url: `/api/reviews/${old}/publish`, headers: { ...H, cookie }, payload: { text: 'Merci.\n' + sig } });
  await pool.query(`UPDATE reviews SET created_at = now() - interval '13 months' WHERE id=$1`, [old]);
  const n = await purgeExpiredReviews(12);
  assert.equal(n, 1);
  const { rows } = await pool.query('SELECT author_name, body, rating, published_reply, body_purged_at FROM reviews WHERE id=$1', [old]);
  assert.equal(rows[0].body, ''); assert.equal(rows[0].author_name, '');
  assert.equal(rows[0].rating, 5); assert.ok(rows[0].published_reply); assert.ok(rows[0].body_purged_at);
  const { rows: v } = await pool.query('SELECT count(*) AS n FROM reply_variants WHERE review_id=$1', [old]);
  assert.equal(Number(v[0].n), 0);
  const { rows: f } = await pool.query('SELECT body FROM reviews WHERE id=$1', [fresh]);
  assert.ok(f[0].body.length > 0, 'avis récent intact');
  // Idempotente ; génération refusée sur un avis purgé ; 0 mois = jamais.
  assert.equal(await purgeExpiredReviews(12), 0);
  const g = await generate(cookie, old);
  assert.equal(g.statusCode, 409);
  assert.equal(await purgeExpiredReviews(0), 0);
});

/* ====================== RGPD : export, suppression, sessions ====================== */
test('export RGPD : JSON complet du compte', async () => {
  const cookie = await signup('exp@x.fr'); await createRestaurant(cookie);
  await addReview(cookie, { author_name: 'Export' });
  const r = await app.inject({ method: 'GET', url: '/api/export-data', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.user.email, 'exp@x.fr');
  assert.equal(d.restaurants[0].name, 'La Table d’Aurore');
  assert.equal(d.restaurants[0].profile.city, 'Lyon');
  assert.equal(d.reviews[0].author_name, 'Export');
  assert.equal(d.cgv_acceptances[0].version, CGV_VERSION);
});

test('suppression de compte : données liées supprimées, session invalidée', async () => {
  const cookie = await signup('bye@x.fr'); await createRestaurant(cookie, { name: 'Bye' });
  const { id } = await addReview(cookie);
  const del = await app.inject({ method: 'POST', url: '/api/auth/delete-user', headers: { ...H, cookie }, payload: { password: PASSWORD } });
  assert.equal(del.statusCode, 200, `delete-user → ${del.body}`);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 401);
  const { rows } = await pool.query('SELECT count(*) AS n FROM reviews WHERE id=$1', [id]);
  assert.equal(rows[0].n, '0');
  const { rows: comp } = await pool.query(`SELECT count(*) AS n FROM companies WHERE name='Bye'`);
  assert.equal(comp[0].n, '0');
});

test('sessions : liste, révocation', async () => {
  const c1 = await signup('sess@x.fr');
  const s2 = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'sess@x.fr', password: PASSWORD } });
  const c2 = cookieOf(s2);
  const list = await app.inject({ method: 'GET', url: '/api/auth/list-sessions', headers: { cookie: c1 } });
  assert.equal(list.statusCode, 200);
  const sessions = list.json();
  assert.ok(sessions.length >= 2);
  const other = sessions.find((s: any) => !c1.includes(s.token));
  const rev = await app.inject({ method: 'POST', url: '/api/auth/revoke-session', headers: { ...H, cookie: c1 }, payload: { token: other.token } });
  assert.equal(rev.statusCode, 200);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c2 } });
  assert.equal(me.statusCode, 401);
});

/* ====================== Back-office ====================== */
const ADMIN_COOKIE = () => signup('admin@lemotduchef.test', 'Admin');

test('admin : non authentifié → 401, non-admin → 403 sur toutes les routes', async () => {
  const user = await signup('user-no-admin@x.fr');
  const checks: Array<{ method: any; url: string }> = [
    { method: 'GET', url: '/api/admin/stats' }, { method: 'GET', url: '/api/admin/companies' },
    { method: 'GET', url: '/api/admin/users' }, { method: 'GET', url: '/api/admin/settings' },
    { method: 'GET', url: '/api/admin/audit' }, { method: 'POST', url: '/api/admin/users/x/verify' },
    { method: 'POST', url: '/api/admin/users/x/suspend' }, { method: 'DELETE', url: '/api/admin/users/x' },
    { method: 'PUT', url: '/api/admin/settings' }, { method: 'POST', url: '/api/admin/accounts' },
  ];
  for (const c of checks) {
    const anon = await app.inject({ ...c, headers: H, payload: {} });
    assert.equal(anon.statusCode, 401, `anon ${c.method} ${c.url}`);
    const r = await app.inject({ ...c, headers: { ...H, cookie: user }, payload: {} });
    assert.equal(r.statusCode, 403, `non-admin ${c.method} ${c.url} → ${r.statusCode} ${r.body}`);
  }
});

test('admin : statistiques et listes — métadonnées uniquement, jamais le contenu des avis', async () => {
  const admin = await ADMIN_COOKIE();
  const client = await signup('client-meta@x.fr');
  const cid = await createRestaurant(client, { name: 'Bistrot Surest', city: 'Nantes' });
  await makePro(cid);
  const { id } = await addReview(client, { author_name: 'Zéphirin', body: 'NOTE SECRETE XYZ, plat délicieux.' });
  await generate(client, id);
  const stats = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { ...H, cookie: admin } });
  assert.equal(stats.statusCode, 200);
  const s = stats.json();
  assert.ok(s.companies >= 1 && s.users >= 2 && s.reviews >= 1 && s.generations >= 1 && s.inputTokens > 0);
  const co = await app.inject({ method: 'GET', url: '/api/admin/companies?search=surest', headers: { ...H, cookie: admin } });
  const body = JSON.stringify(co.json());
  for (const leak of ['Zéphirin', 'NOTE SECRETE', 'délicieux', 'author', 'body'])
    assert.ok(!body.includes(leak), `fuite dans /admin/companies : ${leak}`);
  const row = co.json().companies[0];
  assert.equal(row.name, 'Bistrot Surest'); assert.equal(row.city, 'Nantes');
  assert.ok(Number(row.reviews_count) >= 1 && Number(row.generations_month) >= 1);
  const us = await app.inject({ method: 'GET', url: '/api/admin/users?search=client-meta', headers: { ...H, cookie: admin } });
  assert.equal(us.json().users[0].company_name, 'Bistrot Surest');
});

test('admin : suspension révoque les sessions et bloque la connexion ; audit', async () => {
  const admin = await ADMIN_COOKIE();
  const client = await signup('suspend-me@x.fr');
  const { rows } = await pool.query(`SELECT id FROM "user" WHERE email='suspend-me@x.fr'`);
  const uid = rows[0].id;
  const { rows: before } = await pool.query('SELECT count(*) AS n FROM audit_log');
  const sus = await app.inject({ method: 'POST', url: `/api/admin/users/${uid}/suspend`, headers: { ...H, cookie: admin }, payload: { suspended: true } });
  assert.equal(sus.statusCode, 200, sus.body);
  const q = await app.inject({ method: 'GET', url: '/api/me', headers: { ...H, cookie: client } });
  assert.equal(q.statusCode, 401);
  const s = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'suspend-me@x.fr', password: PASSWORD } });
  assert.ok([401, 403].includes(s.statusCode));
  const re = await app.inject({ method: 'POST', url: `/api/admin/users/${uid}/suspend`, headers: { ...H, cookie: admin }, payload: { suspended: false } });
  assert.equal(re.statusCode, 200);
  const s2 = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'suspend-me@x.fr', password: PASSWORD } });
  assert.equal(s2.statusCode, 200);
  const { rows: after_ } = await pool.query('SELECT count(*) AS n FROM audit_log');
  assert.equal(Number(after_[0].n), Number(before[0].n) + 2);
});

test('admin : interrupteur d\'inscription en base, invitation par email', async () => {
  const admin = await ADMIN_COOKIE();
  const off = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...H, cookie: admin }, payload: { signupEnabled: false } });
  assert.equal(off.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().signupEnabled, false);
  assert.equal((await signupRaw('closed@x.fr')).statusCode, 403);
  await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...H, cookie: admin }, payload: { signupEnabled: true } });
  const r = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers: { ...H, cookie: admin }, payload: { email: 'invite@x.fr', name: 'Invité Test' } });
  assert.equal(r.statusCode, 200, r.body);
  const mail = lastMailTo('invite@x.fr', /réinitialisation/i);
  assert.ok(mail);
  const set = await app.inject({ method: 'POST', url: '/api/auth/reset-password', headers: H, payload: { token: tokenFrom(mail!), newPassword: 'nouveaumotdepasse1' } });
  assert.equal(set.statusCode, 200);
  const sign = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: H, payload: { email: 'invite@x.fr', password: 'nouveaumotdepasse1' } });
  assert.equal(sign.statusCode, 200);
});

/* ====================== Stripe ====================== */
const stripeClient = new Stripe('sk_test_fake');
const WH_SECRET = 'whsec_testsecret';
function whReq(event: object) {
  const payload = JSON.stringify(event);
  return {
    payload,
    headers: {
      'content-type': 'application/json', host: 'localhost:3510',
      'stripe-signature': stripeClient.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET }),
    } as Record<string, string>,
  };
}

test('stripe : signature invalide → 400, signature absente → 400', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/stripe/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=faux', host: 'localhost:3510' }, payload: '{}' });
  assert.equal(bad.statusCode, 400);
  const none = await app.inject({ method: 'POST', url: '/api/stripe/webhook', headers: { 'content-type': 'application/json', host: 'localhost:3510' }, payload: '{}' });
  assert.equal(none.statusCode, 400);
});

test('billing : état exposé, prix publics Pro mensuel/annuel seulement, offre inconnue refusée', async () => {
  const cookie = await signup('billing-view@x.fr'); await createRestaurant(cookie);
  const b = await app.inject({ method: 'GET', url: '/api/billing', headers: { ...H, cookie } });
  assert.equal(b.json().plan, 'free');
  assert.equal(b.json().usage.limit, 3);
  const p = await app.inject({ method: 'GET', url: '/api/billing/prices' });
  assert.equal(p.statusCode, 200);
  assert.deepEqual(p.json().prices.map((x: any) => x.key).sort(), ['pro_monthly', 'pro_yearly']);
  const r = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { ...H, cookie }, payload: { priceId: 'price_team_m' } });
  assert.equal(r.statusCode, 400);
});

test('stripe : erreur Stripe → 502 propre, sans propagation de statut ni d\'en-têtes', async () => {
  const cookie = await signup('stripe-down@x.fr'); const cid = await createRestaurant(cookie, { name: 'StripeDown' });
  const s = stripe()!;
  const fail = async () => { throw new Stripe.errors.StripeAuthenticationError({ message: 'Invalid API Key provided', statusCode: 401, headers: { 'access-control-allow-origin': '*' }, requestId: 'req_test' } as any); };
  const orig = [s.customers.create, s.checkout.sessions.create, s.billingPortal.sessions.create];
  s.customers.create = fail as any; s.checkout.sessions.create = fail as any; s.billingPortal.sessions.create = fail as any;
  try {
    const r1 = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { ...H, cookie, origin: 'https://lemotduchef.test' }, payload: { priceId: 'price_pro_m' } });
    assert.equal(r1.statusCode, 502);
    assert.match(r1.json().error, /service de paiement/i);
    assert.equal(r1.headers['access-control-allow-origin'], 'https://lemotduchef.test');
    await pool.query('UPDATE companies SET stripe_customer_id=$1 WHERE id=$2', ['cus_down', cid]);
    const r2 = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { ...H, cookie, origin: 'https://lemotduchef.test' }, payload: { priceId: 'price_pro_m' } });
    assert.equal(r2.statusCode, 502);
    const r3 = await app.inject({ method: 'POST', url: '/api/billing/portal', headers: { ...H, cookie, origin: 'https://lemotduchef.test' }, payload: {} });
    assert.equal(r3.statusCode, 502);
    assert.notEqual(r3.headers['access-control-allow-origin'], '*');
  } finally {
    [s.customers.create, s.checkout.sessions.create, s.billingPortal.sessions.create] = orig as any;
  }
});

/* ====================== CGV ====================== */
test('cgv : inscription refusée sans acceptation ; ré-acceptation exigée après changement de version', async () => {
  const no = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: H, payload: { email: 'nocgv@x.fr', password: PASSWORD, name: 'N' } });
  assert.equal(no.statusCode, 400);
  const cookie = await signup('reaccept@x.fr'); await createRestaurant(cookie);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().cgv_current, true);
  await pool.query(`DELETE FROM cgv_acceptances WHERE user_id=(SELECT id FROM "user" WHERE email='reaccept@x.fr')`);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().cgv_current, false);
  const chk = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: { ...H, cookie }, payload: { priceId: 'price_pro_m' } });
  assert.equal(chk.statusCode, 428);
  const ok = await app.inject({ method: 'POST', url: '/api/legal/accept', headers: { ...H, cookie }, payload: { version: CGV_VERSION } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().cgv_current, true);
});

test('pages légales publiques servies par la SPA', async () => {
  for (const p of ['/mentions-legales', '/cgv', '/confidentialite']) {
    const r = await app.inject({ method: 'GET', url: p });
    assert.equal(r.statusCode, 200, p);
    assert.match(r.body, /Le Mot du Chef/);
  }
});
