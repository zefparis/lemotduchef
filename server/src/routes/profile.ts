import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireCompany, requireSession } from '../guards.js';
import { validateProfile } from '../validate.js';
import type { PromptProfile } from '../llm/prompt.js';

export const PROFILE_SELECT = `
  SELECT c.id, c.name, p.city, p.cuisine, p.signature_name, p.signature_role, p.tone, p.strengths,
         p.practical_info, p.google_maps_url, p.google_review_url, p.contact_email, p.contact_phone, p.updated_at
  FROM companies c JOIN restaurant_profiles p ON p.company_id = c.id`;

export async function loadProfile(companyId: string): Promise<(PromptProfile & { id: string; google_maps_url: string; google_review_url: string }) | null> {
  const { rows } = await pool.query(`${PROFILE_SELECT} WHERE c.id=$1`, [companyId]);
  return rows[0] ?? null;
}

export default async function profileRoutes(app: FastifyInstance) {
  // Nom affiché dans le compte (hors email — changé via /api/auth/change-email).
  app.patch('/api/profile', { preHandler: requireSession }, async (req, reply) => {
    const name = String((req.body as any)?.name ?? '').trim();
    if (!name || name.length > 100)
      return reply.code(400).send({ error: 'Nom invalide (1 à 100 caractères).' });
    await pool.query('UPDATE "user" SET name=$2 WHERE id=$1', [req.userId, name]);
    return { ok: true };
  });

  // Profil du restaurant : alimente le rédacteur (ton, points forts, signature…).
  app.get('/api/restaurant', { preHandler: requireCompany }, async (req, reply) => {
    const p = await loadProfile(req.companyId!);
    if (!p) return reply.code(404).send({ error: 'Profil introuvable.' });
    return p;
  });

  app.patch('/api/restaurant', { preHandler: requireCompany }, async (req, reply) => {
    const v = validateProfile(req.body);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const p = v.value;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE companies SET name=$2 WHERE id=$1', [req.companyId, p.name]);
      await client.query(
        `INSERT INTO restaurant_profiles (company_id, city, cuisine, signature_name, signature_role, tone, strengths,
           practical_info, google_maps_url, google_review_url, contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (company_id) DO UPDATE SET city=$2, cuisine=$3, signature_name=$4, signature_role=$5, tone=$6,
           strengths=$7, practical_info=$8, google_maps_url=$9, google_review_url=$10, contact_email=$11,
           contact_phone=$12, updated_at=now()`,
        [req.companyId, p.city, p.cuisine, p.signature_name, p.signature_role, p.tone, p.strengths,
         p.practical_info, p.google_maps_url, p.google_review_url, p.contact_email, p.contact_phone]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    return { ok: true };
  });
}
