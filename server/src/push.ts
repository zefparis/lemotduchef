import webPush from 'web-push';
import { config } from './config.js';
import { pool } from './db.js';

// Envoi Web Push (VAPID). Désactivé proprement sans clés : toute la
// fonctionnalité reste dormant tant que VAPID_PUBLIC/PRIVATE_KEY ne sont
// pas définies côté serveur.
export const pushEnabled = () => !!(config.push.vapidPublicKey && config.push.vapidPrivateKey);

let vapidReady = false;
function vapid() {
  if (!vapidReady) {
    webPush.setVapidDetails(config.push.subject, config.push.vapidPublicKey, config.push.vapidPrivateKey);
    vapidReady = true;
  }
  return webPush;
}

export interface PushSettings {
  enabled: boolean; rating_max: number;
  quiet_start: string | null; quiet_end: string | null; hide_content: boolean;
}
export const DEFAULT_SETTINGS: PushSettings = { enabled: false, rating_max: 3, quiet_start: null, quiet_end: null, hide_content: false };

export async function loadPushSettings(companyId: string): Promise<PushSettings> {
  const { rows } = await pool.query<PushSettings>(
    'SELECT enabled, rating_max, quiet_start::text, quiet_end::text, hide_content FROM push_settings WHERE company_id=$1', [companyId]);
  return rows[0] ?? DEFAULT_SETTINGS;
}

// « Heures de silence » : si définies, aucune notification pendant la plage
// (traversée de minuit gérée : 22h → 7h).
function inQuietHours(s: PushSettings, now = new Date()): boolean {
  if (!s.quiet_start || !s.quiet_end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const toMin = (h: string) => { const [H, M] = h.split(':').map(Number); return H * 60 + M; };
  const a = toMin(s.quiet_start), b = toMin(s.quiet_end);
  return a === b ? true : a < b ? (t >= a && t < b) : (t >= a || t < b);
}

export interface PushPayload {
  reviewId: string;
  rating: number;
  author: string;      // prénom/nom affiché (donnée publique)
  excerpt: string;     // extrait court de l'avis
}
export interface RawPush { title: string; body: string; url: string; tag: string }

// Envoi brut à tous les abonnements du restaurant (hors réglages) — utilisé
// par le test explicite et par notifyRepliesReady après filtrage. Purge les
// abonnements invalides (404/410). Retourne le nombre d'envois.
export async function sendPushDirect(companyId: string, p: RawPush, log: { warn: (o: unknown, m?: string) => void }): Promise<number> {
  const { rows: subs } = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE company_id=$1', [companyId]);
  if (!subs.length) return 0;
  const payload = JSON.stringify(p);
  let sent = 0;
  const dead: string[] = [];
  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await vapid().sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
      sent++;
    } catch (err: any) {
      // 404/410 : l'abonnement est mort côté navigateur → purge.
      if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(sub.endpoint);
      else log.warn({ status: err?.statusCode, endpoint: sub.endpoint.slice(0, 60) }, 'push: échec d’envoi');
    }
  }));
  if (dead.length) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1)', [dead]).catch(() => {});
  return sent;
}

// Envoie « 3 réponses prêtes » à tous les appareils du restaurant dont les
// réglages le permettent (activé, note ≤ seuil, hors heures de silence).
export async function notifyRepliesReady(companyId: string, p: PushPayload, log: { warn: (o: unknown, m?: string) => void }): Promise<number> {
  if (!pushEnabled()) return 0;
  const s = await loadPushSettings(companyId);
  if (!s.enabled || p.rating > s.rating_max || inQuietHours(s)) return 0;
  const stars = '★'.repeat(p.rating) + '☆'.repeat(5 - p.rating);
  return sendPushDirect(companyId, s.hide_content
    ? { title: `Nouvel avis ${p.rating}★ — 3 réponses prêtes`, body: 'Ouvrez pour choisir et publier.', url: `/?avis=${p.reviewId}`, tag: `review-${p.reviewId}` }
    : { title: `${stars} Avis de ${p.author || 'un client'}`, body: `« ${p.excerpt} » — 3 réponses prêtes`, url: `/?avis=${p.reviewId}`, tag: `review-${p.reviewId}` }, log);
}
