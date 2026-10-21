import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { isPro } from '../stripe.js';
import { chevaletPdf, encartPdf, qrPngBuffer } from '../pdf.js';
import type { CollectContent } from '../pdf.js';
import { loadProfile } from './profile.js';

const DEFAULT_TITLE = 'Votre avis compte';
const DEFAULT_MESSAGE = 'Un instant pour partager votre expérience sur Google nous aide énormément. Merci de votre visite !';

// Engagement affiché dans l'interface et respecté par le code : le QR mène
// directement à Google, pour tous les clients, sans tri ni contrepartie.
const PLEDGE = 'Le QR code mène directement à la page d’avis Google, pour tous vos clients. Nous ne proposons ni page « êtes-vous satisfait ? » qui ne redirigerait que les clients contents, ni récompense en échange d’un avis : ces pratiques sont interdites par les règles de Google et constituent une pratique commerciale trompeuse.';

const HELP_STEPS = [
  'Ouvrez Google Maps ou la recherche Google, connecté avec le compte qui gère votre fiche.',
  'Sur votre fiche, cliquez sur « Demander des avis » (ou « Obtenir plus d’avis » dans le tableau de bord Profil d’entreprise).',
  'Copiez le lien court proposé (de la forme https://g.page/r/…/review) et collez-le ci-dessous.',
  'Astuce : sans accès au tableau de bord, le lien https://search.google.com/local/writereview?placeid=… fonctionne aussi avec l’identifiant de lieu de votre fiche.',
];

async function content(companyId: string): Promise<{ c: CollectContent | null; settings: { title: string; message: string }; profile: Awaited<ReturnType<typeof loadProfile>> }> {
  const profile = await loadProfile(companyId);
  const { rows } = await pool.query<{ title: string; message: string }>('SELECT title, message FROM collect_settings WHERE company_id=$1', [companyId]);
  const settings = { title: rows[0]?.title || DEFAULT_TITLE, message: rows[0]?.message || DEFAULT_MESSAGE };
  if (!profile?.google_review_url) return { c: null, settings, profile };
  return { c: { restaurant: profile.name, title: settings.title, message: settings.message, reviewUrl: profile.google_review_url }, settings, profile };
}

const PRO_ONLY = { error: 'Les supports imprimables (chevalet, encarts) sont réservés à l’offre Pro.', code: 'PLAN_LIMIT' };
const NO_LINK = { error: 'Renseignez d’abord votre lien « laisser un avis » dans Collecte d’avis.', code: 'NO_REVIEW_URL' };

export default async function collectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireCompany);

  app.get('/api/collect', async (req) => {
    const { settings, profile } = await content(req.companyId!);
    return {
      title: settings.title, message: settings.message,
      defaults: { title: DEFAULT_TITLE, message: DEFAULT_MESSAGE },
      google_review_url: profile?.google_review_url ?? '',
      google_maps_url: profile?.google_maps_url ?? '',
      pro: await isPro(req.companyId!),
      pledge: PLEDGE, helpSteps: HELP_STEPS,
    };
  });

  app.patch('/api/collect', async (req, reply) => {
    const b = req.body as any;
    const title = String(b?.title ?? '').trim();
    const message = String(b?.message ?? '').trim();
    if (title.length > 60) return reply.code(400).send({ error: 'Titre trop long (60 caractères).' });
    if (message.length > 200) return reply.code(400).send({ error: 'Message trop long (200 caractères).' });
    // Aucune incitation ni contrepartie dans le texte imprimé.
    if (/(offert|gratuit|remise|réduction|reduction|cadeau|en échange|en echange|-\s?\d+\s?%|\d+\s?% de)/i.test(`${title} ${message}`))
      return reply.code(400).send({ error: 'Le texte ne peut pas proposer de contrepartie (remise, cadeau, offert…) en échange d’un avis.' });
    await pool.query(
      `INSERT INTO collect_settings (company_id, title, message) VALUES ($1,$2,$3)
       ON CONFLICT (company_id) DO UPDATE SET title=$2, message=$3, updated_at=now()`,
      [req.companyId, title, message]);
    return { ok: true };
  });

  // Aperçu du QR (toutes offres) : permet de vérifier le lien avant d'imprimer.
  app.get('/api/collect/qr.png', async (req, reply) => {
    const { c } = await content(req.companyId!);
    if (!c) return reply.code(409).send(NO_LINK);
    reply.header('Content-Type', 'image/png');
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(await qrPngBuffer(c.reviewUrl)));
  });

  const sendPdf = async (req: any, reply: FastifyReply, kind: 'chevalet' | 'encart') => {
    if (!(await isPro(req.companyId))) return reply.code(403).send(PRO_ONLY);
    const { c } = await content(req.companyId);
    if (!c) return reply.code(409).send(NO_LINK);
    const bytes = kind === 'chevalet' ? await chevaletPdf(c) : await encartPdf(c);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="lemotduchef-${kind}.pdf"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(bytes));
  };
  app.get('/api/collect/chevalet.pdf', (req, reply) => sendPdf(req, reply, 'chevalet'));
  app.get('/api/collect/encart.pdf', (req, reply) => sendPdf(req, reply, 'encart'));
}
