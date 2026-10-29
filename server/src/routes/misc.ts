import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireSession } from '../guards.js';
import { config } from '../config.js';
import { signupEnabledNow } from '../settings.js';
import { CGV_VERSION, cgvAccepted } from '../legal.js';
import { validateProfile } from '../validate.js';
import { CONTEXT_TAGS, TONES } from '../llm/prompt.js';
import { llmConfigured } from '../llm/provider.js';
import { FREE_MONTHLY_LIMIT } from '../stripe.js';
import { availableSources } from '../sources/index.js';
import { marketFromRequest, marketConfig, userMarket } from '../markets.js';

export default async function miscRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Sonde légère pour monitoring externe (Uptime Kuma) — pas de requête DB.
  app.get('/health', async () => ({ status: 'ok' }));

  // Configuration publique minimale lue par le frontend au démarrage.
  // L'interrupteur en base (back-office) est prioritaire sur l'env.
  // Le marché est déduit du domaine de la requête (Origin), pas du client.
  app.get('/api/config', async (req) => {
    const market = marketFromRequest(req);
    const m = marketConfig(market);
    return {
      signupEnabled: await signupEnabledNow(),
      cgvVersion: CGV_VERSION,
      freeMonthlyReplies: FREE_MONTHLY_LIMIT,
      freeHistoryDays: config.freeHistoryDays,
      reviewRetentionMonths: config.reviewRetentionMonths,
      contextTags: CONTEXT_TAGS,
      tones: Object.keys(TONES),
      sources: availableSources(),
      llmReady: llmConfigured(),
      market,
      lang: m.lang,
      languages: m.languages,
      currency: m.currency,
      timezone: m.timezone,
      brand: m.brand,
      tagline: m.tagline,
      paymentProvider: m.payment.provider,
      company: m.company,
      legalRoutes: m.legalRoutes,
    };
  });

  app.get('/api/me', { preHandler: requireSession }, async (req) => {
    const { rows } = await pool.query<{ id: string; name: string; city: string; onboarded: boolean; market: string }>(
      `SELECT c.id, c.name, COALESCE(p.city,'') AS city, (p.company_id IS NOT NULL) AS onboarded, c.market
       FROM companies c
       JOIN memberships m ON m.company_id = c.id
       LEFT JOIN restaurant_profiles p ON p.company_id = c.id
       WHERE m.user_id = $1 ORDER BY m.created_at LIMIT 1`, [req.userId]);
    const { rows: users } = await pool.query<{ name: string; email: string; market: string; lang: string }>(
      'SELECT name, email, market, lang FROM "user" WHERE id=$1', [req.userId]);
    const admin = !!users[0] && config.adminEmails.has(users[0].email.toLowerCase());
    const cgv_current = await cgvAccepted(req.userId!);
    const market = await userMarket(req.userId!);
    const lang = users[0]?.lang || marketConfig(market).lang;
    return { user: users[0] ? { ...users[0], lang } : null, restaurant: rows[0] ?? null, session_id: req.sessionId, admin, cgv_current, market };
  });

  // Onboarding : création du restaurant (compte + profil) à la première
  // connexion. Propriétaire = utilisateur courant. Une seule fois par compte.
  app.post('/api/restaurants', { preHandler: requireSession }, async (req, reply) => {
    const v = validateProfile(req.body);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const p = v.value;
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM memberships WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (existing.length)
      return reply.code(409).send({ error: 'Un restaurant est déjà associé à ce compte.' });
    const market = await userMarket(req.userId!);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO companies (name, market) VALUES ($1,$2) RETURNING id', [p.name, market]);
      const id = rows[0].id;
      await client.query(
        `INSERT INTO memberships (company_id, user_id, role) VALUES ($1,$2,'owner')`, [id, req.userId]);
      await client.query(
        `INSERT INTO restaurant_profiles (company_id, city, cuisine, signature_name, signature_role, tone, address_form,
           avoid_phrases, strengths, practical_info, google_maps_url, google_review_url, contact_email, contact_phone, show_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, p.city, p.cuisine, p.signature_name, p.signature_role, p.tone, p.address_form,
         p.avoid_phrases, p.strengths, p.practical_info, p.google_maps_url, p.google_review_url,
         p.contact_email, p.contact_phone, p.show_phone]);
      await client.query('INSERT INTO collect_settings (company_id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      return reply.code(201).send({ id, name: p.name, city: p.city, onboarded: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  });

  // Export RGPD : toutes les données du compte en JSON.
  app.get('/api/export-data', { preHandler: requireSession }, async (req) => {
    const { rows: users } = await pool.query(
      'SELECT id, name, email, "emailVerified" AS email_verified, "createdAt" AS created_at FROM "user" WHERE id=$1',
      [req.userId]);
    const { rows: restaurants } = await pool.query(
      `SELECT c.id, c.name, c.plan, c.subscription_status, c.created_at, m.role, to_jsonb(p) - 'company_id' AS profile,
              to_jsonb(cs) - 'company_id' AS collect_settings
       FROM companies c JOIN memberships m ON m.company_id = c.id
       LEFT JOIN restaurant_profiles p ON p.company_id = c.id
       LEFT JOIN collect_settings cs ON cs.company_id = c.id
       WHERE m.user_id=$1`, [req.userId]);
    const { rows: reviews } = await pool.query(
      `SELECT r.id, r.source, r.author_name, r.rating, r.body, r.visited_on::text, r.context_tags, r.context_note,
              r.flags, r.published_reply, r.published_at, r.body_purged_at, r.created_at
       FROM reviews r
       WHERE r.company_id IN (SELECT company_id FROM memberships WHERE user_id=$1)
       ORDER BY r.created_at`, [req.userId]);
    const { rows: variants } = await pool.query(
      `SELECT v.review_id, v.generation_id, v.idx, v.text, v.warnings, v.created_at FROM reply_variants v
       WHERE v.company_id IN (SELECT company_id FROM memberships WHERE user_id=$1)
       ORDER BY v.created_at`, [req.userId]);
    const { rows: generations } = await pool.query(
      `SELECT g.id, g.review_id, g.provider, g.model, g.prompt_version, g.input_tokens, g.output_tokens, g.duration_ms, g.created_at
       FROM generations g
       WHERE g.company_id IN (SELECT company_id FROM memberships WHERE user_id=$1)
       ORDER BY g.created_at`, [req.userId]);
    const { rows: cgv } = await pool.query(
      'SELECT version, accepted_at FROM cgv_acceptances WHERE user_id=$1 ORDER BY accepted_at', [req.userId]);
    return {
      exported_at: new Date().toISOString(),
      user: users[0] ?? null,
      restaurants,
      reviews,
      reply_variants: variants,
      generations,
      cgv_acceptances: cgv,
    };
  });
}
