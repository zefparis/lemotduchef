import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireCompany, clientIp } from '../guards.js';
import { validateReview } from '../validate.js';
import { computeFlags, reportGuide } from '../moderation.js';
import type { Flag } from '../moderation.js';
import { remainingGenerations, FREE_MONTHLY_LIMIT, isPro } from '../stripe.js';
import { generateReplies, QuotaExceededError } from '../llm/generate.js';
import { LlmError, llmConfigured } from '../llm/provider.js';
import { loadProfile } from './profile.js';
import { userLang } from '../markets.js';
import type { ReplyLang } from '../llm/langdetect.js';

const LIMIT_ERROR = {
  error: `Limite de l'offre Gratuit atteinte : ${FREE_MONTHLY_LIMIT} réponses générées ce mois-ci. Passez en Pro pour continuer sans limite.`,
  code: 'PLAN_LIMIT',
};

const REVIEW_SELECT = `
  SELECT r.id, r.source, r.external_id, r.author_name, r.rating, r.body, r.visited_on::text AS visited_on,
         r.context_tags, r.context_note, r.flags, r.published_reply, r.published_at, r.body_purged_at,
         r.created_at, r.updated_at,
         (SELECT count(*) FROM generations g WHERE g.review_id=r.id)::int AS generation_count
  FROM reviews r`;

// Les comptes dont l'email figure dans ADMIN_EMAILS génèrent sans quota :
// la limite de l'offre Gratuit ne leur est pas appliquée.
async function isAdminAccount(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [userId]);
  return !!rows[0] && config.adminEmails.has(rows[0].email.toLowerCase());
}

async function variantsOf(reviewId: string, companyId: string) {
  const { rows } = await pool.query(
    `SELECT v.id, v.generation_id, v.idx, v.text, v.translation, v.warnings, v.needs_review AS "needsReview", v.created_at
       FROM reply_variants v
      WHERE v.review_id=$1 AND v.company_id=$2
      ORDER BY v.created_at DESC, v.idx ASC LIMIT 9`, [reviewId, companyId]);
  return rows;
}

export default async function reviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireCompany);

  // Historique — toujours borné au restaurant de la session. Offre Gratuit :
  // profondeur limitée à FREE_HISTORY_DAYS (le reste est conservé, pas affiché).
  app.get('/api/reviews', async (req) => {
    const { search = '', rating = '', status = '' } = req.query as Record<string, string>;
    const pro = await isPro(req.companyId!);
    const params: unknown[] = [req.companyId];
    let where = 'r.company_id = $1';
    if (!pro && config.freeHistoryDays > 0) {
      params.push(config.freeHistoryDays);
      where += ` AND r.created_at >= now() - ($${params.length}::int * interval '1 day')`;
    }
    const rt = Number(rating);
    if (Number.isInteger(rt) && rt >= 1 && rt <= 5) { params.push(rt); where += ` AND r.rating = $${params.length}`; }
    if (status === 'published') where += ' AND r.published_reply IS NOT NULL';
    if (status === 'pending') where += ' AND r.published_reply IS NULL';
    if (status === 'flagged') where += ' AND cardinality(r.flags) > 0';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (lower(r.author_name) LIKE $${params.length} OR lower(r.body) LIKE $${params.length})`;
    }
    const { rows } = await pool.query(`${REVIEW_SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT 500`, params);
    const { rows: tot } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM reviews WHERE company_id=$1', [req.companyId]);
    return { reviews: rows, total: Number(tot[0].n), historyLimitedDays: pro ? null : config.freeHistoryDays };
  });

  // Saisie d'un avis (source manuelle). Les indicateurs « avis suspect » sont
  // calculés ici ; le guide de signalement est renvoyé avec l'avis.
  app.post('/api/reviews', async (req, reply) => {
    const v = validateReview(req.body);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const r = v.value;
    const flags = computeFlags(r);
    const { rows } = await pool.query(
      `INSERT INTO reviews (company_id, source, author_name, rating, body, visited_on, context_tags, context_note, flags)
       VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.companyId, r.author_name, r.rating, r.body, r.visited_on, r.context_tags, r.context_note, flags]);
    const profile = await loadProfile(req.companyId!);
    return reply.code(201).send({ id: rows[0].id, flags, report: reportGuide(flags, profile?.name ?? '') });
  });

  app.get('/api/reviews/:id', async (req, reply) => {
    const { rows } = await pool.query(`${REVIEW_SELECT} WHERE r.id=$1 AND r.company_id=$2`, [(req.params as any).id, req.companyId]);
    if (!rows.length) return reply.code(404).send({ error: 'Avis introuvable.' });
    const profile = await loadProfile(req.companyId!);
    return { review: rows[0], variants: await variantsOf(rows[0].id, req.companyId!), report: reportGuide(rows[0].flags as Flag[], profile?.name ?? '') };
  });

  app.patch('/api/reviews/:id', async (req, reply) => {
    const v = validateReview(req.body);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const r = v.value;
    const flags = computeFlags(r);
    const { rowCount } = await pool.query(
      `UPDATE reviews SET author_name=$3, rating=$4, body=$5, visited_on=$6, context_tags=$7, context_note=$8, flags=$9,
              body_purged_at=NULL, updated_at=now()
       WHERE id=$1 AND company_id=$2`,
      [(req.params as any).id, req.companyId, r.author_name, r.rating, r.body, r.visited_on, r.context_tags, r.context_note, flags]);
    if (!rowCount) return reply.code(404).send({ error: 'Avis introuvable.' });
    const profile = await loadProfile(req.companyId!);
    return { ok: true, flags, report: reportGuide(flags, profile?.name ?? '') };
  });

  app.delete('/api/reviews/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM reviews WHERE id=$1 AND company_id=$2', [(req.params as any).id, req.companyId]);
    if (!rowCount) return reply.code(404).send({ error: 'Avis introuvable.' });
    return { ok: true };
  });

  // Génération des 3 variantes. Quota Gratuit appliqué ici, côté serveur.
  await app.register(async (gen) => {
    await gen.register(rateLimit, { max: config.rateLimitGenerate, timeWindow: '1 minute', keyGenerator: clientIp });
    gen.post('/api/reviews/:id/generate', async (req, reply) => {
      if (!llmConfigured()) return reply.code(503).send({ error: 'Le rédacteur n’est pas configuré sur ce serveur (LLM).' });
      const { rows } = await pool.query(
        `SELECT id, author_name, rating, body, visited_on::text AS visited_on, context_tags, context_note, body_purged_at
           FROM reviews WHERE id=$1 AND company_id=$2`, [(req.params as any).id, req.companyId]);
      const review = rows[0];
      if (!review) return reply.code(404).send({ error: 'Avis introuvable.' });
      if (review.body_purged_at) return reply.code(409).send({ error: 'Le texte de cet avis a été effacé (durée de conservation atteinte) : ressaisissez-le pour générer une réponse.' });
      const profile = await loadProfile(req.companyId!);
      if (!profile) return reply.code(409).send({ error: 'Complétez le profil de votre restaurant avant de générer une réponse.', code: 'NO_PROFILE' });
      const admin = await isAdminAccount(req.userId!);
      try {
        // Le quota est réservé atomiquement dans generateReplies (FOR UPDATE) :
        // pas de dépassement par appels concurrents, les échecs comptent aussi.
        const includeAuthorName = (req.body as any)?.include_author_name !== false;
        const uiLang = await userLang(req.userId!);
        const out = await generateReplies(req.companyId!, review.id, profile, review, req.log, { unlimited: admin, includeAuthorName, uiLang: uiLang as ReplyLang });
        const left = admin ? Number.POSITIVE_INFINITY : await remainingGenerations(req.companyId!);
        return {
          generationId: out.generationId,
          variants: out.variants,
          usage: out.usage,
          rejected: out.rejected,
          quota: { remaining: Number.isFinite(left) ? left : null, limit: Number.isFinite(left) ? FREE_MONTHLY_LIMIT : null },
        };
      } catch (err) {
        if (err instanceof QuotaExceededError) return reply.code(403).send(LIMIT_ERROR);
        if (err instanceof LlmError) {
          const status = err.kind === 'config' ? 503 : err.kind === 'timeout' ? 504 : 502;
          // Jamais le détail technique du fournisseur au client (loggé côté serveur).
          const message = err.kind === 'upstream'
            ? 'La génération est momentanément indisponible, réessayez dans un instant.'
            : err.message;
          return reply.code(status).send({ error: message, code: 'LLM_' + err.kind.toUpperCase() });
        }
        throw err;
      }
    });
  });

  // Statut « publiée sur Google » : coché manuellement, avec le texte final
  // (variante éventuellement retouchée). published:false pour annuler.
  app.post('/api/reviews/:id/publish', async (req, reply) => {
    const b = req.body as any;
    const id = (req.params as any).id;
    if (b?.published === false) {
      const { rowCount } = await pool.query(
        'UPDATE reviews SET published_reply=NULL, published_at=NULL, updated_at=now() WHERE id=$1 AND company_id=$2', [id, req.companyId]);
      if (!rowCount) return reply.code(404).send({ error: 'Avis introuvable.' });
      return { ok: true, published: false };
    }
    const text = String(b?.text ?? '').trim();
    if (!text || text.length > 2000) return reply.code(400).send({ error: 'Texte de la réponse requis (2 000 caractères max).' });
    const { rowCount } = await pool.query(
      'UPDATE reviews SET published_reply=$3, published_at=now(), updated_at=now() WHERE id=$1 AND company_id=$2',
      [id, req.companyId, text]);
    if (!rowCount) return reply.code(404).send({ error: 'Avis introuvable.' });
    return { ok: true, published: true };
  });

  // Quota courant (affiché dans l'écran Répondre).
  app.get('/api/usage', async (req) => {
    const left = await remainingGenerations(req.companyId!);
    const pro = !Number.isFinite(left);
    const admin = !pro && await isAdminAccount(req.userId!);
    const unlimited = pro || admin;
    return { plan: pro ? 'pro' : 'free', remaining: unlimited ? null : left, limit: unlimited ? null : FREE_MONTHLY_LIMIT, admin, llmReady: llmConfigured() };
  });
}
