import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';

// Configuration par marché — source unique : public/markets.js, lu au
// démarrage et extrait comme JSON pur (le front le charge tel quel via
// <script>). Une config absente ou invalide bloque le boot, comme config.ts.
// Les secrets (clés de paiement) restent dans l'environnement, jamais ici.

export type Market = 'fr' | 'za';
export const MARKET_IDS: Market[] = ['fr', 'za'];
export const isMarket = (v: unknown): v is Market => v === 'fr' || v === 'za';

export interface MarketConfig {
  lang: string;
  languages: string[];
  locale: string;
  currency: string;
  timezone: string;
  brand: string;
  tagline: string;
  frontUrl: string;
  apiUrl: string;
  mailFrom: string;
  reviewMailAddress: string;
  payment: { provider: 'stripe' | 'paystack' };
  company: { name: string; registration: string; address: string; email: string; phone: string };
  prices?: Record<string, string>;
  legalRoutes: { mentions: string; cgv: string; privacy: string };
  domains: string[];
}
interface MarketsFile { default: Market; markets: Record<string, Partial<MarketConfig>> }

function loadMarketsFile(): MarketsFile {
  const file = path.join(config.staticRoot, 'markets.js');
  const text = fs.readFileSync(file, 'utf8');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as MarketsFile;
  if (!isMarket(parsed.default) || !parsed.markets?.fr || !parsed.markets?.za)
    throw new Error('markets.js invalide : clés default/markets.fr/markets.za attendues.');
  return parsed;
}

const file = loadMarketsFile();
const marketConfigCache = new Map<Market, MarketConfig>();

export function marketConfig(market: Market): MarketConfig {
  let m = marketConfigCache.get(market);
  if (m) return m;
  const raw = file.markets[market]!;
  // Compléments d'environnement, prioritaires sur markets.js : le domaine
  // ZA n'étant pas encore arrêté, ZA_DOMAINS et les surcharges mail/front
  // restent pilotables sans rebuild du front. Côté FR, les variables
  // historiques (FRONT_URL, MAIL_FROM, REVIEW_MAIL_ADDRESS, FR_DOMAINS)
  // gardent leur rôle — aucune régression sur le marché existant.
  const extra = market === 'za'
    ? {
        domains: config.zaDomains,
        frontUrl: config.zaFrontUrl,
        mailFrom: config.zaMailFrom,
        reviewMailAddress: config.zaReviewMailAddress,
      }
    : {
        domains: config.frDomains,
        frontUrl: process.env.FRONT_URL ?? '',
        mailFrom: process.env.MAIL_FROM ?? '',
        reviewMailAddress: process.env.REVIEW_MAIL_ADDRESS ?? '',
      };
  m = {
    lang: raw.lang ?? 'fr',
    languages: raw.languages?.length ? raw.languages : ['fr', 'en'],
    locale: raw.locale ?? 'fr-FR',
    currency: raw.currency ?? 'EUR',
    timezone: raw.timezone ?? 'Europe/Paris',
    brand: raw.brand ?? 'Le Mot du Chef',
    tagline: raw.tagline ?? '',
    frontUrl: extra.frontUrl || raw.frontUrl || config.frontUrl,
    apiUrl: raw.apiUrl || config.baseUrl,
    mailFrom: extra.mailFrom || raw.mailFrom || config.smtp.from,
    reviewMailAddress: extra.reviewMailAddress || raw.reviewMailAddress || config.mailIngest.address,
    payment: { provider: raw.payment?.provider === 'paystack' ? 'paystack' : 'stripe' },
    company: { name: '', registration: '', address: '', email: '', phone: '', ...(raw.company ?? {}) },
    prices: raw.prices,
    legalRoutes: raw.legalRoutes ?? { mentions: '/mentions-legales', cgv: '/cgv', privacy: '/confidentialite' },
    domains: [...(raw.domains ?? []), ...extra.domains],
  };
  marketConfigCache.set(market, m);
  return m;
}

/* ---------- Détection du marché ---------- */
// Le marché est déterminé par le DOMAINE — jamais par une valeur fournie
// librement par le client. Sur une requête : l'Origin (front séparé) puis le
// Host (même origine) ; à défaut, le marché par défaut.
const hostOf = (v: string) => v.split(':')[0].trim().toLowerCase();
const domainToMarket = new Map<string, Market>();
for (const id of MARKET_IDS)
  for (const d of marketConfig(id).domains) domainToMarket.set(d.toLowerCase(), id);

export function marketFromHost(host: string | undefined | null): Market | null {
  if (!host) return null;
  return domainToMarket.get(hostOf(host)) ?? null;
}
export function marketFromOrigin(origin: string | undefined | null): Market | null {
  if (!origin) return null;
  try { return marketFromHost(new URL(origin).host); } catch { return null; }
}
export function marketFromHeaders(headers: { get(name: string): string | null }): Market {
  return marketFromOrigin(headers.get('origin'))
      ?? marketFromHost(headers.get('host'))
      ?? file.default;
}
export const marketFromRequest = (req: { headers: Record<string, unknown> }): Market => {
  const get = (n: string) => (typeof req.headers[n] === 'string' ? req.headers[n] as string : null);
  return marketFromOrigin(get('origin')) ?? marketFromHost(get('host')) ?? file.default;
};

/* ---------- Garde-fou prospection ---------- */
// La prospection automatique (projet art50check, base séparée) n'importe que
// des contacts du marché FR. La colonne market est la SEULE frontière : tout
// outil d'envoi de séquences doit filtrer sur allowsProspecting(market).
// Un compte ou contact du marché ZA ne peut entrer dans aucune séquence.
export const allowsProspecting = (market: Market): boolean => market === 'fr';

/* ---------- Accès base ---------- */
export async function userMarket(userId: string): Promise<Market> {
  const { rows } = await pool.query<{ market: Market }>('SELECT market FROM "user" WHERE id=$1', [userId]);
  return isMarket(rows[0]?.market) ? rows[0].market : file.default;
}
export async function companyMarket(companyId: string): Promise<Market> {
  const { rows } = await pool.query<{ market: Market }>('SELECT market FROM companies WHERE id=$1', [companyId]);
  return isMarket(rows[0]?.market) ? rows[0].market : file.default;
}

// Langue de l'interface d'un compte : préférence explicite (user.lang), sinon
// la langue par défaut de son marché.
export async function userLang(userId: string): Promise<string> {
  const { rows } = await pool.query<{ lang: string; market: Market }>(
    'SELECT lang, market FROM "user" WHERE id=$1', [userId]);
  if (rows[0]?.lang && rows[0].lang !== '') return rows[0].lang;
  return marketConfig(isMarket(rows[0]?.market) ? rows[0].market : file.default).lang;
}

/* ---------- Adresses et URL par marché ---------- */
export const mailFromFor = (market: Market): string => marketConfig(market).mailFrom;
export const frontUrlFor = (market: Market): string => marketConfig(market).frontUrl;
export const reviewMailAddressFor = (market: Market): string => marketConfig(market).reviewMailAddress;

/* ---------- Fuseau horaire ---------- */
// Minutes locales dans le fuseau du marché (heures de silence des
// notifications, fenêtres d'envoi). Intl gère l'heure d'été.
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
