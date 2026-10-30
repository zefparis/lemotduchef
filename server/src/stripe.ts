import Stripe from 'stripe';
import { config } from './config.js';
import { pool } from './db.js';

// Client Stripe paresseux : sans STRIPE_SECRET_KEY la facturation est
// désactivée proprement (enabled:false côté API, boutons masqués côté front).
let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!config.stripe.secretKey) return null;
  client ??= new Stripe(config.stripe.secretKey, { timeout: 15000, maxNetworkRetries: 1 });
  return client;
}
export const stripeEnabled = () => !!config.stripe.secretKey;

// Prix par marché : même compte Stripe, mêmes clés — seuls les objets
// prix diffèrent (EUR/fr et ZAR/en pour le marché ZA, ids d'env
// STRIPE_ZA_PRICE_*). planForPrice connaît les deux jeux d'ids.
import type { Market } from './markets.js';
export const pricesFor = (market: Market): Record<string, string> =>
  market === 'za' ? config.stripeZa.prices : market === 'ke' ? config.stripeKe.prices : config.stripe.prices;
const PRICE_TO_PLAN: Record<string, 'pro'> = {};
for (const m of ['fr', 'za', 'ke'] as const)
  for (const id of Object.values(pricesFor(m))) if (id) PRICE_TO_PLAN[id] = 'pro';
export const planForPrice = (priceId: string) => PRICE_TO_PLAN[priceId];
export const knownPriceIds = (market: Market = 'fr') => new Set(Object.values(pricesFor(market)).filter(Boolean));
export const visiblePriceEntries = (market: Market = 'fr') => Object.entries(pricesFor(market)).filter(([, id]) => id);

// Cache des montants des prix lus depuis l'API Stripe (10 min) : les montants
// affichés restent synchronisés avec le dashboard, jamais codés en dur.
type PriceInfo = { unit_amount: number | null; currency: string; interval: string | null };
const priceCache = new Map<string, { at: number; info: PriceInfo }>();
const PRICE_TTL = 10 * 60 * 1000;

export async function priceInfo(priceId: string): Promise<PriceInfo | null> {
  const hit = priceCache.get(priceId);
  if (hit && Date.now() - hit.at < PRICE_TTL) return hit.info;
  const s = stripe();
  if (!s || !priceId) return null;
  try {
    const p = await s.prices.retrieve(priceId);
    const info: PriceInfo = {
      unit_amount: p.unit_amount,
      currency: p.currency,
      interval: (p.recurring?.interval as string) ?? null,
    };
    priceCache.set(priceId, { at: Date.now(), info });
    return info;
  } catch {
    return null;
  }
}

// Offre effective : le plan payé ne vaut que pendant la vie de l'abonnement
// (Stripe gère les relances de paiement en past_due ; à la résiliation,
// customer.subscription.deleted remet plan=free). Aucune donnée supprimée.
export type CompanyBilling = {
  plan: string; subscription_status: string; stripe_customer_id: string | null;
  subscription_price_id: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean; payment_provider: string;
  paystack_subscription_code: string | null;
};

export async function companyBilling(companyId: string): Promise<CompanyBilling> {
  const { rows } = await pool.query<CompanyBilling>(
    `SELECT plan, subscription_status, stripe_customer_id, subscription_price_id,
            current_period_end::text, cancel_at_period_end,
            payment_provider, paystack_subscription_code
     FROM companies WHERE id=$1`, [companyId]);
  return rows[0] ?? {
    plan: 'free', subscription_status: 'none', stripe_customer_id: null,
    subscription_price_id: null, current_period_end: null, cancel_at_period_end: false,
    payment_provider: 'stripe', paystack_subscription_code: null,
  };
}

export const effectivePlan = (b: Pick<CompanyBilling, 'plan' | 'subscription_status'>) =>
  ['active', 'trialing', 'past_due'].includes(b.subscription_status) ? b.plan : 'free';

export const isPro = async (companyId: string) => effectivePlan(await companyBilling(companyId)) === 'pro';

// Quota Gratuit : générations (une = 3 variantes) sur le mois civil en cours (UTC).
export const FREE_MONTHLY_LIMIT = config.freeMonthlyReplies;

export async function monthlyGenerationCount(companyId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM generations
      WHERE company_id=$1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [companyId]);
  return Number(rows[0].n);
}

// Générations restantes ce mois-ci (Infinity hors plan Gratuit).
export async function remainingGenerations(companyId: string): Promise<number> {
  const b = await companyBilling(companyId);
  if (effectivePlan(b) !== 'free') return Number.POSITIVE_INFINITY;
  return Math.max(0, FREE_MONTHLY_LIMIT - (await monthlyGenerationCount(companyId)));
}
