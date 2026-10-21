import { pool } from './db.js';
import { config } from './config.js';

// Purge RGPD : les avis contiennent des données de clients finaux (prénom,
// texte). Passé REVIEW_RETENTION_MONTHS, texte, prénom, contexte et variantes
// générées sont effacés ; la note, la date et la réponse publiée (texte du
// restaurateur, déjà public sur Google) sont conservées pour l'historique.
export async function purgeExpiredReviews(months = config.reviewRetentionMonths): Promise<number> {
  if (!months) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `UPDATE reviews SET body='', author_name='', context_note='', body_purged_at=now(), updated_at=now()
        WHERE body_purged_at IS NULL AND created_at < now() - ($1::int * interval '1 month')
        RETURNING id`, [months]);
    if (rows.length)
      await client.query('DELETE FROM reply_variants WHERE review_id = ANY($1::uuid[])', [rows.map(r => r.id)]);
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// Au démarrage puis une fois par jour (processus unique : pas de verrou distribué).
export function scheduleRetention(log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void }): () => void {
  const run = () => purgeExpiredReviews()
    .then(n => { if (n) log.info({ purged: n }, 'rgpd: avis purgés'); })
    .catch(err => log.warn({ err }, 'rgpd: purge en échec'));
  run();
  const t = setInterval(run, 24 * 60 * 60 * 1000);
  t.unref();
  return () => clearInterval(t);
}
