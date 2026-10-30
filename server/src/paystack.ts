import crypto from 'node:crypto';
import { config } from './config.js';
import type { Market } from './markets.js';
import { marketConfig } from './markets.js';

// ── Provider Paystack (préparé, NON activé) ──
// Activé uniquement quand markets.js déclare payment.provider='paystack'
// pour le marché ET que PAYSTACK_ZA_SECRET_KEY est renseignée. Tant que
// ces conditions ne sont pas réunies, aucune requête Paystack ne part.
// Abonnements : plans créés côté dashboard Paystack (PLN_*), souscription
// via transaction/initialize, résiliation via subscription/disable,
// webhooks signés HMAC-SHA512 (en-tête x-paystack-signature).

const BASE = 'https://api.paystack.co';

export const paystackConfigured = () => !!config.paystack.secretKey;
export const paystackEnabledFor = (market: Market): boolean =>
  paystackConfigured() && marketConfig(market).payment.provider === 'paystack';

export const paystackPlans = () => config.paystack.plans;
export const knownPaystackPlanCodes = () => new Set(Object.values(config.paystack.plans).filter(Boolean));
export const planCodeForKey = (key: string) => (config.paystack.plans as Record<string, string>)[key];

export async function paystackFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({})) as { status?: boolean; message?: string; data?: any };
  if (!res.ok || body.status === false)
    throw new Error(`paystack ${res.status}: ${body.message ?? 'erreur provider'}`);
  return body;
}

// Souscription : initialize une transaction adossée au plan ; Paystack
// renvoie authorization_url (équivalent de l'URL Checkout Stripe).
export async function paystackInitialize(email: string, planCode: string, meta: Record<string, string>) {
  return paystackFetch('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({ email, plan: planCode, metadata: meta }),
  });
}

// Signature webhook : HMAC-SHA512 du corps brut, en-tête x-paystack-signature.
export function verifyPaystackSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature || !config.paystack.secretKey) return false;
  const expected = crypto.createHmac('sha512', config.paystack.secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// code plan Paystack → offre interne (les plans PLN_* de l'env = Pro).
export function planForPaystackCode(code: string | null | undefined): 'pro' | undefined {
  return code && knownPaystackPlanCodes().has(code) ? 'pro' : undefined;
}
