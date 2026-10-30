import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function req(name: string, fallback?: string): string {
  // Chaîne vide traitée comme absente (un `VAR=` laissé vide dans .env est une
  // erreur fréquente). En production, aucun repli codé n'est toléré.
  const raw = process.env[name];
  const v = raw || (isProd ? undefined : fallback);
  if (v === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';
const baseUrl = process.env.BASE_URL ?? 'http://localhost:3500';
// Origines frontend autorisées (déploiement séparé, ex. Vercel → api.<domaine>).
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
// Origine du frontend pour les liens envoyés par email (vérification, reset).
const frontUrl = (process.env.FRONT_URL ?? corsOrigins[0] ?? baseUrl).replace(/\/$/, '');

const positiveInt = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3500),
  // Dans le conteneur l'API écoute sur 0.0.0.0 ; en local sur loopback.
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: req('DATABASE_URL', 'postgres://lemotduchef:lemotduchef@127.0.0.1:5445/lemotduchef'),
  baseUrl,
  corsOrigins,
  frontUrl,
  // SameSite=Lax par défaut : front sur <domaine>/www + API sur api.<domaine>
  // sont le MÊME site (même domaine enregistrable) → Lax suffit et n'est pas
  // bloqué comme cookie tiers par Safari/Firefox. 'none' uniquement pour les
  // tests sur des origines d'un autre site (ex. *.vercel.app).
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'lax') === 'none' ? 'none' as const : 'lax' as const,
  // Pas d'attribut Domain par défaut : cookie host-only sur api.<domaine>.
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  // Inscription publique : activée en dev, à garder désactivée en production
  // tant que la vérification d'email n'est pas opérationnelle.
  signupEnabled: process.env.SIGNUP_ENABLED ? process.env.SIGNUP_ENABLED === 'true' : !isProd,
  authSecret: req('BETTER_AUTH_SECRET', 'dev-only-secret-change-me-0123456789abcdef'),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : baseUrl.startsWith('https:'),
  // Cookie SameSite=Lax : navigation normale OK, POST inter-sites bloqué (avec garde CSRF en plus).
  staticRoot: process.env.STATIC_ROOT ?? path.resolve(__dirname, '../../public'),
  // cloudflared (tunnel sur l'hôte) relaie X-Forwarded-* : trustProxy actif par défaut.
  trustProxy: process.env.TRUST_PROXY !== 'false',
  // Débit /api/auth/* par IP (anti force brute). Surchargeable en test.
  rateLimitAuth: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30),
  rateLimitSignup: Number(process.env.RATE_LIMIT_SIGNUP_MAX ?? 10),
  // Débit des générations LLM par IP (coût). Surchargeable en test.
  rateLimitGenerate: Number(process.env.RATE_LIMIT_GENERATE_MAX ?? 20),
  // Emails autorisés à administrer (back-office /api/admin/*). Env seule,
  // jamais exposée côté front ni via l'API.
  adminEmails: new Set(
    (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ),
  // SMTP pour les emails transactionnels (vérification, reset). Sans SMTP,
  // l'inscription publique est refusée (cf. garde dans app.ts).
  // SMTP_HOST=log → driver de test : emails capturés en mémoire, aucun réseau.
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'Le Mot du Chef <noreply@localhost>',
  },
  // Notifications Web Push (VAPID). Sans clés, /api/push renvoie enabled:false
  // et aucun envoi n'est tenté. Générer : npx web-push generate-vapid-keys.
  push: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? 'mailto:contact@lemotduchef.fr',
  },
  // Ingestion des avis par email (relève IMAP de la boîte avis@…).
  // MAIL_INGEST_ENABLED=false par défaut : tout le pipeline est dormant.
  mailIngest: {
    enabled: (process.env.MAIL_INGEST_ENABLED ?? '') === 'true',
    host: process.env.IMAP_HOST ?? 'imap.mail.ovh.net',
    port: Number(process.env.IMAP_PORT ?? 993),
    user: process.env.IMAP_USER ?? '',
    pass: process.env.IMAP_PASS ?? '',
    tls: (process.env.IMAP_TLS ?? 'true') !== 'false',
    pollIntervalSec: Number(process.env.IMAP_POLL_INTERVAL_SEC ?? 120),
    address: (process.env.REVIEW_MAIL_ADDRESS ?? 'avis@lemotduchef.fr').toLowerCase(),
    codeLength: Number(process.env.REVIEW_MAIL_CODE_LENGTH ?? 8),
    // Dossier où ranger les mails traités (vide = simple marquage « lu »).
    processedFolder: process.env.IMAP_PROCESSED_FOLDER ?? '',
  },
  // Abonnement Stripe (mode test ou live selon la clé). Sans clé, la
  // facturation est désactivée et /api/billing renvoie enabled:false.
  // Les montants affichés sont relus depuis l'API Stripe — jamais codés en dur.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL ?? '',
    prices: {
      pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? '',
      pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? '',
    },
  },
  // Domaines supplémentaires de détection FR (préprod, tests) — le marché
  // ZA a l'équivalent ZA_DOMAINS ci-dessous.
  frDomains: (process.env.FR_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // ── Marché ZA (compléments de public/markets.js) ──
  // Domaine za.lemotduchef.fr : mêmes boîtes email que le marché FR
  // (avis@lemotduchef.fr — le code avis+xxxx identifie déjà le restaurant).
  // ZA_DOMAINS reste utile pour des domaines supplémentaires de test ou un
  // futur .co.za sans rebuild.
  zaDomains: (process.env.ZA_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  keDomains: (process.env.KE_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  cdDomains: (process.env.CD_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Paiement ZA : Paystack en priorité (provider par défaut du marché) ;
  // clés Stripe ZA dédiées acceptées aussi si le compte les ouvre.
  paystack: {
    secretKey: process.env.PAYSTACK_ZA_SECRET_KEY ?? '',
    publicKey: process.env.PAYSTACK_ZA_PUBLIC_KEY ?? '',
    plans: {
      pro_monthly: process.env.PAYSTACK_ZA_PLAN_MONTHLY ?? '',
      pro_yearly: process.env.PAYSTACK_ZA_PLAN_YEARLY ?? '',
    },
  },
  stripeZa: {
    secretKey: process.env.STRIPE_ZA_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_ZA_WEBHOOK_SECRET ?? '',
    prices: {
      pro_monthly: process.env.STRIPE_ZA_PRICE_PRO_MONTHLY ?? '',
      pro_yearly: process.env.STRIPE_ZA_PRICE_PRO_YEARLY ?? '',
    },
  },
  // Marché KE : même compte Stripe que FR/ZA ; seuls les ids de prix
  // KES diffèrent (carte uniquement au checkout).
  stripeKe: {
    prices: {
      pro_monthly: process.env.STRIPE_KE_PRICE_PRO_MONTHLY ?? '',
      pro_yearly: process.env.STRIPE_KE_PRICE_PRO_YEARLY ?? '',
    },
  },
  // Marché CD : même compte Stripe que FR/ZA/KE ; ids de prix USD,
  // carte uniquement. Provider « unipay » (mobile money) prévu dans la
  // couche paiement — non implémenté tant que non configuré.
  stripeCd: {
    prices: {
      pro_monthly: process.env.STRIPE_CD_PRICE_PRO_MONTHLY ?? '',
      pro_yearly: process.env.STRIPE_CD_PRICE_PRO_YEARLY ?? '',
    },
  },
  // Offre Gratuit : nombre de générations de réponses par mois civil et par
  // restaurant (une génération = 3 variantes). Appliqué côté serveur.
  freeMonthlyReplies: positiveInt('FREE_MONTHLY_REPLIES', 5),
  // Offre Gratuit : profondeur d'historique consultable (jours). Pro : illimité.
  freeHistoryDays: positiveInt('FREE_HISTORY_DAYS', 30),
  // RGPD : texte et prénom d'auteur des avis effacés N mois après la saisie
  // (0 = jamais ; mentionné dans la politique de confidentialité).
  reviewRetentionMonths: positiveInt('REVIEW_RETENTION_MONTHS', 12),
  // Fournisseur LLM — appel côté serveur uniquement.
  // LLM_PROVIDER=anthropic (prod) | mock (dev/tests, refusé en production).
  llm: {
    provider: (process.env.LLM_PROVIDER ?? (isProd ? 'anthropic' : 'mock')) as 'anthropic' | 'mock',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'claude-sonnet-4-5-20250929',
    timeoutMs: positiveInt('LLM_TIMEOUT_MS', 40_000),
    // 3 réponses ≤ 180 jetons chacune (plafond AI Act) + overhead outil.
    maxOutputTokens: positiveInt('LLM_MAX_OUTPUT_TOKENS', 1200),
  },
};

// Garde-fous production : le serveur refuse de démarrer plutôt que tourner sur
// une configuration silencieusement fausse (secrets de repli, clés de test,
// mock LLM, webhook non vérifiable).
if (config.isProd) {
  const key = config.stripe.secretKey;
  if (/^(sk|rk)_test_/.test(key))
    throw new Error('STRIPE_SECRET_KEY est une clé de test (sk_test_/rk_test_) — interdite en production.');
  if (key && !config.stripe.webhookSecret)
    throw new Error('STRIPE_WEBHOOK_SECRET manquante alors que STRIPE_SECRET_KEY est définie.');
  if (config.llm.provider === 'mock')
    throw new Error('LLM_PROVIDER=mock est interdit en production.');
}
