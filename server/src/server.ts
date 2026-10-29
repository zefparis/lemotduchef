import { buildApp } from './app.js';
import { migrate, pool } from './db.js';
import { config } from './config.js';

const applied = await migrate();
if (applied.length) console.log(`Migrations appliquées : ${applied.join(', ')}`);

// Générations restées « running » après un crash/redémarrage → marquées
// échouées (elles ne consomment pas de quota : status non décompté).
await pool.query(`UPDATE generations SET status='failed', duration_ms=0
  WHERE status='running' AND created_at < now() - interval '15 minutes'`);

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });
const { startIngestLoop } = await import('./ingest/mail.js');
startIngestLoop(app.log);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
