import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { loadPushSettings, sendPushDirect, pushEnabled } from '../push.js';

// Endpoints des notifications push : clé publique VAPID, abonnements des
// appareils du restaurateur, réglages, notification de test.
export default async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push/vapid', async () => ({
    enabled: pushEnabled(),
    publicKey: pushEnabled() ? config.push.vapidPublicKey : null,
  }));

  app.get('/api/push/state', { preHandler: requireCompany }, async (req) => {
    const settings = await loadPushSettings(req.companyId!);
    const { rows } = await pool.query<{ id: string; endpoint: string; user_agent: string; created_at: string }>(
      'SELECT id, endpoint, user_agent, created_at FROM push_subscriptions WHERE company_id=$1 ORDER BY created_at DESC', [req.companyId!]);
    return {
      enabled: pushEnabled(), settings,
      subscriptions: rows,
      count: rows.length,
    };
  });

  app.put('/api/push/settings', { preHandler: requireCompany }, async (req, reply) => {
    const b = (req.body ?? {}) as { enabled?: boolean; rating_max?: number; quiet_start?: string | null; quiet_end?: string | null; hide_content?: boolean };
    const rm = Number(b.rating_max);
    if (!(rm >= 1 && rm <= 5)) return reply.code(400).send({ error: 'Note seuil invalide (1 à 5).' });
    const tm = (v: unknown) => v == null || v === '' ? null : /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : 'INVALID';
    const qs = tm(b.quiet_start), qe = tm(b.quiet_end);
    if (qs === 'INVALID' || qe === 'INVALID') return reply.code(400).send({ error: 'Heure invalide (format HH:MM).' });
    await pool.query(
      `INSERT INTO push_settings (company_id, enabled, rating_max, quiet_start, quiet_end, hide_content)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id) DO UPDATE SET enabled=$2, rating_max=$3, quiet_start=$4, quiet_end=$5, hide_content=$6, updated_at=now()`,
      [req.companyId!, !!b.enabled, rm, qs, qe, !!b.hide_content]);
    return { ok: true };
  });

  app.post('/api/push/subscribe', { preHandler: requireCompany }, async (req, reply) => {
    const b = (req.body ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!b.endpoint || !/^https:\/\//.test(b.endpoint) || !b.keys?.p256dh || !b.keys?.auth)
      return reply.code(400).send({ error: 'Abonnement invalide.' });
    await pool.query(
      `INSERT INTO push_subscriptions (company_id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET company_id=$1, user_id=$2, p256dh=$4, auth=$5, user_agent=$6, updated_at=now()`,
      [req.companyId!, req.userId!, b.endpoint, b.keys.p256dh, b.keys.auth, String((req.headers['user-agent'] ?? '')).slice(0, 300)]);
    return { ok: true };
  });

  app.delete('/api/push/subscribe', { preHandler: requireCompany }, async (req, reply) => {
    const b = (req.body ?? {}) as { endpoint?: string };
    if (!b.endpoint) return reply.code(400).send({ error: 'Endpoint requis.' });
    await pool.query('DELETE FROM push_subscriptions WHERE company_id=$1 AND endpoint=$2', [req.companyId!, b.endpoint]);
    return { ok: true };
  });

  // Notification de test vers les appareils du restaurateur (réglages de
  // silence/filtre ignorés : c'est un test explicite).
  app.post('/api/push/test', { preHandler: requireCompany }, async (req, reply) => {
    if (!pushEnabled()) return reply.code(503).send({ error: 'Push non configuré côté serveur.' });
    const sent = await sendPushDirect(req.companyId!, {
      title: 'Le Mot du Chef — test',
      body: 'Les notifications fonctionnent sur cet appareil.',
      url: '/', tag: 'test',
    }, req.log);
    if (sent === 0) return reply.code(404).send({ error: 'Aucun appareil enregistré sur ce compte.' });
    return { sent };
  });
}
