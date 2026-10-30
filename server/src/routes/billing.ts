import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { config } from '../config.js';
import {
  stripe, stripeEnabled, priceInfo, planForPrice, knownPriceIds, visiblePriceEntries,
  companyBilling, effectivePlan, monthlyGenerationCount, FREE_MONTHLY_LIMIT, pricesFor,
} from '../stripe.js';
import { cgvAccepted } from '../legal.js';
import { frontUrlFor, marketConfig, marketFromRequest } from '../markets.js';
import {
  paystackConfigured, paystackEnabledFor, paystackInitialize, paystackFetch,
  verifyPaystackSignature, planForPaystackCode, planCodeForKey,
} from '../paystack.js';

// Abonnement Le Mot du Chef via Stripe. Le webhook est la source de vérité :
// plan/statut/période sont écrits par les événements, jamais par le client.

// Erreur Stripe → 502 propre : le statusCode et les headers de la réponse
// Stripe (dont access-control-allow-origin:*) ne sont jamais propagés.
const STRIPE_DOWN = 'Le service de paiement est momentanément indisponible.';

async function companyContact(companyId: string) {
  const { rows } = await pool.query<{ name: string; city: string | null; contact_email: string | null; email: string | null }>(
    `SELECT c.name, p.city, p.contact_email, u.email
       FROM companies c
       LEFT JOIN restaurant_profiles p ON p.company_id=c.id
       LEFT JOIN memberships m ON m.company_id=c.id AND m.role='owner'
       LEFT JOIN "user" u ON u.id=m.user_id
      WHERE c.id=$1 LIMIT 1`, [companyId]);
  return rows[0];
}

// Toutes les requêtes du webhook passent par le client de la transaction de
// « claim » : le marquage stripe_events et le traitement sont atomiques.
type Q = { query: (text: string, params?: unknown[]) => Promise<any> };
type AlertLog = { error: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };

// false = aucune entreprise résolue : l'événement est journalisé en alerte
// par l'appelant (donnée orpheline — inutile de faire rejouer Stripe).
async function applySubscription(client: Q, sub: any): Promise<boolean> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  // current_period_end a migré au niveau de l'item dans les API récentes (Basil).
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const plan = priceId ? planForPrice(priceId) : undefined;
  // Résolution : d'abord par customer id, sinon par metadata de l'abonnement.
  let companyId: string | null = null;
  if (customerId) {
    const { rows } = await client.query(
      'SELECT id FROM companies WHERE stripe_customer_id=$1', [customerId]);
    companyId = rows[0]?.id ?? null;
  }
  const metaId = String(sub.metadata?.company_id ?? '');
  if (!companyId && /^[0-9a-f-]{36}$/i.test(metaId)) {
    const { rows } = await client.query(
      'SELECT id FROM companies WHERE id=$1', [metaId]);
    companyId = rows[0]?.id ?? null;
  }
  if (!companyId) return false;
  await client.query(
    `UPDATE companies SET
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       subscription_id = $3,
       subscription_status = $4,
       ${plan ? 'plan = $5,' : ''}
       subscription_price_id = COALESCE($6, subscription_price_id),
       current_period_end = $7,
       cancel_at_period_end = $8,
       payment_provider = 'stripe'
     WHERE id = $1`,
    [companyId, customerId ?? null, sub.id ?? null, sub.status ?? 'none',
     ...(plan ? [plan] : []), priceId,
     periodEnd ? new Date(periodEnd * 1000) : null,
     !!sub.cancel_at_period_end]);
  return true;
}

async function companyIdByCustomer(client: Q, customerId: string | undefined): Promise<string | null> {
  if (!customerId) return null;
  const { rows } = await client.query(
    'SELECT id FROM companies WHERE stripe_customer_id=$1', [customerId]);
  return rows[0]?.id ?? null;
}

// Liaison Checkout → entreprise (checkout.session.completed ou
// async_payment_succeeded). company_id non UUID ou entreprise inconnue :
// alerte sans lever d'erreur (un rejeu ne changerait rien).
async function linkCheckout(client: Q, session: any, log: AlertLog, eventId: string): Promise<void> {
  const raw = String(session.client_reference_id || session.metadata?.company_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(raw)) {
    log.error({ eventId }, 'stripe webhook ALERTE : checkout sans company_id exploitable — client non lié');
    return;
  }
  const { rowCount } = await client.query(
    'UPDATE companies SET stripe_customer_id=$2, subscription_id=$3 WHERE id=$1',
    [raw, session.customer ?? null, session.subscription ?? null]);
  if (!rowCount)
    log.error({ eventId, companyId: raw }, 'stripe webhook ALERTE : company_id inconnu — client non lié');
}

async function handleStripeEvent(client: Q, event: any, log: AlertLog): Promise<void> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.completed': {
      // Ne lier le client que si le paiement est soldé : carte = 'paid',
      // gratuit/essai = 'no_payment_required'. Les moyens de paiement
      // asynchrones arrivent 'unpaid' — la liaison attend
      // checkout.session.async_payment_succeeded.
      if (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required')
        await linkCheckout(client, obj, log, event.id);
      break;
    }
    case 'checkout.session.async_payment_succeeded':
      await linkCheckout(client, obj, log, event.id);
      break;
    case 'checkout.session.async_payment_failed':
      // Paiement asynchrone échoué : rien à lier ; l'abonnement restera
      // incomplete puis expirera (invoice.payment_failed / subscription.deleted).
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      if (!(await applySubscription(client, obj)))
        log.error(
          { eventId: event.id, type: event.type, subscription: obj?.id, customer: obj?.customer },
          'stripe webhook ALERTE : abonnement orphelin — aucune entreprise résolue (stripe_customer_id et metadata.company_id introuvables)');
      break;
    case 'customer.subscription.deleted': {
      const meta = String(obj.metadata?.company_id ?? '');
      const cid = await companyIdByCustomer(client, typeof obj.customer === 'string' ? obj.customer : obj.customer?.id)
        ?? (/^[0-9a-f-]{36}$/i.test(meta) ? meta : null);
      if (cid) {
        await client.query(
          `UPDATE companies SET plan='free', subscription_status='canceled',
             subscription_id=NULL, subscription_price_id=NULL,
             current_period_end=NULL, cancel_at_period_end=false WHERE id=$1`,
          [cid]);
      } else {
        log.error({ eventId: event.id, type: event.type, customer: obj?.customer },
          'stripe webhook ALERTE : résiliation orpheline — aucune entreprise résolue');
      }
      break;
    }
    case 'invoice.paid': {
      const cid = await companyIdByCustomer(client, typeof obj.customer === 'string' ? obj.customer : obj.customer?.id);
      if (cid) await client.query(`UPDATE companies SET subscription_status='active' WHERE id=$1 AND subscription_status <> 'none'`, [cid]);
      break;
    }
    case 'invoice.payment_failed': {
      // Accès conservé pendant la relance Stripe ; la résiliation éventuelle
      // arrive via customer.subscription.deleted → retour Gratuit.
      const cid = await companyIdByCustomer(client, typeof obj.customer === 'string' ? obj.customer : obj.customer?.id);
      if (cid) await client.query(`UPDATE companies SET subscription_status='past_due' WHERE id=$1`, [cid]);
      break;
    }
  }
}

// Résolution entreprise depuis un événement Paystack : metadata.company_id
// (posée à l'initialisation) puis abonnement connu par code.
async function companyIdForPaystack(client: Q, data: any): Promise<string | null> {
  const metaId = String(data?.metadata?.company_id ?? '');
  if (/^[0-9a-f-]{36}$/i.test(metaId)) {
    const { rows } = await client.query('SELECT id FROM companies WHERE id=$1', [metaId]);
    if (rows[0]?.id) return rows[0].id;
  }
  const code = data?.subscription_code ?? data?.subscription?.subscription_code;
  if (code) {
    const { rows } = await client.query('SELECT id FROM companies WHERE paystack_subscription_code=$1', [code]);
    if (rows[0]?.id) return rows[0].id;
  }
  return null;
}

// Événements Paystack : mêmes effets compte que les événements Stripe
// (plan/statut/résiliation/retour Gratuit — le webhook reste la vérité).
async function handlePaystackEvent(client: Q, event: any, log: AlertLog): Promise<void> {
  const data = event.data ?? {};
  const plan = planForPaystackCode(data.plan_code ?? data.plan?.plan_code);
  switch (event.event) {
    case 'subscription.create': {
      const cid = await companyIdForPaystack(client, data);
      if (!cid) { log.error({ type: event.event }, 'paystack webhook ALERTE : abonnement orphelin'); break; }
      await client.query(
        `UPDATE companies SET plan=$2, subscription_status='active',
           subscription_id=$3, paystack_subscription_code=$3, payment_provider='paystack',
           cancel_at_period_end=false WHERE id=$1`,
        [cid, plan ?? 'pro', data.subscription_code ?? null]);
      break;
    }
    case 'charge.success': {
      const cid = await companyIdForPaystack(client, data);
      if (cid) await client.query(`UPDATE companies SET subscription_status='active' WHERE id=$1 AND subscription_status <> 'none'`, [cid]);
      break;
    }
    case 'invoice.payment_failed': {
      const cid = await companyIdForPaystack(client, data);
      if (cid) await client.query(`UPDATE companies SET subscription_status='past_due' WHERE id=$1`, [cid]);
      break;
    }
    case 'subscription.not_renew':
    case 'subscription.disable':
    case 'subscription.expired': {
      const cid = await companyIdForPaystack(client, data);
      if (cid) {
        await client.query(
          `UPDATE companies SET plan='free', subscription_status='canceled',
             subscription_id=NULL, subscription_price_id=NULL,
             current_period_end=NULL, cancel_at_period_end=false WHERE id=$1`, [cid]);
      } else {
        log.error({ type: event.event }, 'paystack webhook ALERTE : résiliation orpheline');
      }
      break;
    }
  }
}

export default async function billingRoutes(app: FastifyInstance) {

  /* ---------- Webhooks paiement (corps brut, signature obligatoire) ---------- */
  await app.register(async (wh) => {
    // Parseur dédié : la signature Stripe porte sur le corps BRUT.
    wh.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, JSON.parse(body as string)); }
      catch (err) { done(err as Error); }
    });

    wh.post('/api/stripe/webhook', async (req: FastifyRequest, reply) => {
      const s = stripe();
      const secret = config.stripe.webhookSecret;
      if (!s || !secret) return reply.code(503).send({ error: 'Facturation non configurée.' });
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') return reply.code(400).send({ error: 'Signature manquante.' });

      let event: any;
      try {
        event = s.webhooks.constructEvent((req as any).rawBody, sig, secret);
      } catch {
        return reply.code(400).send({ error: 'Signature invalide.' });
      }

      // Idempotence transactionnelle : l'event_id est inséré 'processing' puis
      // passé 'done' dans la MÊME transaction que le traitement. Erreur →
      // rollback complet (aucune trace) + 500 → Stripe rejoue proprement.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: claimed } = await client.query(
          `INSERT INTO stripe_events (event_id, type, status) VALUES ($1,$2,'processing')
           ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [event.id, event.type ?? '']);
        if (!claimed.length) {
          const { rows: cur } = await client.query(
            'SELECT status FROM stripe_events WHERE event_id=$1', [event.id]);
          if (cur[0]?.status === 'done') {
            await client.query('ROLLBACK');
            return { received: true, duplicate: true };
          }
          // Ligne restée 'processing' (reprise d'une version précédente) : retraiter.
        }
        await handleStripeEvent(client, event, req.log);
        await client.query(
          `UPDATE stripe_events SET status='done', processed_at=now() WHERE event_id=$1`,
          [event.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        req.log.error({ err, type: event.type, eventId: event.id },
          'stripe webhook ALERTE : traitement échoué — Stripe rejouera l’événement');
        return reply.code(500).send({ error: 'Traitement de l’événement impossible pour le moment.' });
      } finally {
        client.release();
      }
      return { received: true };
    });

    // Webhook Paystack : signature HMAC-SHA512 + idempotence transactionnelle
    // (même mécanique que le webhook Stripe, table dédiée).
    wh.post('/api/paystack/webhook', async (req: FastifyRequest, reply) => {
      if (!paystackConfigured()) return reply.code(503).send({ error: 'Provider non configuré.' });
      const sig = req.headers['x-paystack-signature'];
      if (!verifyPaystackSignature((req as any).rawBody, typeof sig === 'string' ? sig : undefined))
        return reply.code(401).send({ error: 'Signature invalide.' });
      const event: any = req.body;
      const eventId = String(event.id ?? `${event.event}:${JSON.stringify(event.data).slice(0, 64)}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: claimed } = await client.query(
          `INSERT INTO paystack_events (event_id, type, status) VALUES ($1,$2,'processing')
           ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [eventId, event.event ?? '']);
        if (!claimed.length) {
          const { rows: cur } = await client.query(
            'SELECT status FROM paystack_events WHERE event_id=$1', [eventId]);
          if (cur[0]?.status === 'done') {
            await client.query('ROLLBACK');
            return { received: true, duplicate: true };
          }
        }
        await handlePaystackEvent(client, event, req.log);
        await client.query(`UPDATE paystack_events SET status='done', processed_at=now() WHERE event_id=$1`, [eventId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        req.log.error({ err, type: event.event }, 'paystack webhook ALERTE : traitement échoué');
        return reply.code(500).send({ error: 'Traitement impossible pour le moment.' });
      } finally {
        client.release();
      }
      return { received: true };
    });
  });

  /* ---------- Prix publics (montants relus depuis Stripe, en cache) ---------- */
  app.get('/api/billing/prices', async (req) => {
    const entries = visiblePriceEntries(marketFromRequest(req));
    const infos = await Promise.all(entries.map(([, id]) => priceInfo(id)));
    const out = entries.map(([key, id], i) => ({
      key, id,
      plan: planForPrice(id) ?? 'pro',
      interval: key.endsWith('_yearly') ? 'year' : 'month',
      amount_cents: infos[i]?.unit_amount ?? null,
      currency: infos[i]?.currency ?? 'eur',
    }));
    return { enabled: stripeEnabled(), prices: out };
  });

  /* ---------- État d'abonnement de l'entreprise courante ---------- */
  app.get('/api/billing', { preHandler: requireCompany }, async (req) => {
    const b = await companyBilling(req.companyId!);
    const used = await monthlyGenerationCount(req.companyId!);
    const eff = effectivePlan(b);
    const priceEntries = eff === 'free' ? visiblePriceEntries(req.market ?? 'fr') : [];
    const infos = await Promise.all(priceEntries.map(([, id]) => priceInfo(id)));
    const prices = priceEntries.map(([key, id], i) => ({
      key, id, plan: planForPrice(id), interval: key.endsWith('_yearly') ? 'year' : 'month',
      amount_cents: infos[i]?.unit_amount ?? null, currency: infos[i]?.currency ?? 'eur',
    }));
    return {
      enabled: stripeEnabled(),
      plan: eff, rawPlan: b.plan, status: b.subscription_status,
      currentPeriodEnd: b.current_period_end, cancelAtPeriodEnd: b.cancel_at_period_end,
      hasCustomer: !!b.stripe_customer_id,
      usage: { used, limit: eff === 'free' ? FREE_MONTHLY_LIMIT : null },
      prices,
    };
  });

  /* ---------- Souscription (Checkout Stripe ou Paystack selon marché) ---------- */
  app.post('/api/billing/checkout', { preHandler: requireCompany }, async (req, reply) => {
    const market = req.market ?? 'fr';
    const priceId = String((req.body as any)?.priceId ?? '');

    const provider = marketConfig(market).payment.provider;
    // Provider « unipay » (mobile money, marché CD) : emplacement prévu
    // dans la couche de paiement — NON implémenté ; jamais de repli
    // Stripe silencieux si le marché y est basculé par configuration.
    if (provider === 'unipay')
      return reply.code(503).send({ error: 'Paiement mobile money indisponible pour le moment.' });

    // Provider Paystack (désactivé tant que le marché est en provider
    // 'stripe' dans markets.js — voir paystack.ts).
    if (provider === 'paystack') {
      if (!paystackEnabledFor(market))
        return reply.code(503).send({ error: 'Facturation non configurée.' });
      const planCode = planCodeForKey(priceId) ?? priceId;
      if (!planForPaystackCode(planCode))
        return reply.code(400).send({ error: 'Offre inconnue.' });
      if (!(await cgvAccepted(req.userId!)))
        return reply.code(428).send({ error: 'Acceptez les conditions générales pour souscrire.', code: 'CGV_REQUIRED' });
      const c = await companyContact(req.companyId!);
      const email = c?.contact_email || c?.email;
      if (!email) return reply.code(400).send({ error: 'Adresse email requise pour la souscription.' });
      try {
        const r = await paystackInitialize(email, planCode, { company_id: req.companyId! });
        await pool.query(`UPDATE companies SET payment_provider='paystack' WHERE id=$1`, [req.companyId]);
        return { url: r.data?.authorization_url };
      } catch (err) {
        req.log.warn({ err }, 'paystack transaction/initialize a échoué');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
    }

    const s = stripe();
    if (!s) return reply.code(503).send({ error: 'Facturation non configurée.' });
    if (!knownPriceIds(market).has(priceId))
      return reply.code(400).send({ error: 'Offre inconnue.' });
    // Souscription = acceptation des CGV de la version courante (app, avant
    // redirection vers Checkout ; le portail Stripe affiche en plus le lien).
    if (!(await cgvAccepted(req.userId!)))
      return reply.code(428).send({ error: 'Acceptez les conditions générales de vente pour souscrire.', code: 'CGV_REQUIRED' });

    const b = await companyBilling(req.companyId!);
    let customerId = b.stripe_customer_id;
    if (!customerId) {
      const c = await companyContact(req.companyId!);
      const email = c?.contact_email || c?.email || undefined;
      let customer: Stripe.Customer | undefined;
      try {
        // Réutiliser le client Stripe existant pour cet email plutôt que d'en
        // créer un doublon à chaque souscription.
        if (email) {
          const { data: existing } = await s.customers.list({ email, limit: 1 });
          customer = existing[0];
          if (customer && !(customer.metadata as any)?.company_id)
            customer = await s.customers.update(customer.id,
              { metadata: { company_id: req.companyId!, city: c?.city ?? '' } });
        }
        customer ??= await s.customers.create({
          name: c?.name ?? undefined,
          email,
          metadata: { company_id: req.companyId!, city: c?.city ?? '' },
        });
      } catch (err) {
        req.log.warn({ err }, 'stripe customers lookup/create a échoué');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
      customerId = customer.id;
      await pool.query(`UPDATE companies SET stripe_customer_id=$2, payment_provider='stripe' WHERE id=$1`, [req.companyId, customerId]);
    }

    const front = frontUrlFor(market);
    const cgvUrl = `${front}${marketConfig(market).legalRoutes.cgv}`;
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      locale: market === 'fr' || market === 'cd' ? 'fr' : 'en',
      // Kenya : carte uniquement (pas de mobile money ni de lien de
      // paiement alternatif au Checkout pendant le pilote).
      ...(market === 'ke' || market === 'cd' ? { payment_method_types: ['card' as const] } : {}),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      // Aucune TVA collectée (franchise, art. 293 B CGI) : pas d'automatic_tax.
      client_reference_id: req.companyId,
      metadata: { company_id: req.companyId! },
      subscription_data: { metadata: { company_id: req.companyId! } },
      // Case « j'accepte les CGV » sur la page Checkout (si le compte Stripe l'autorise).
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message: market === 'fr'
            ? `En souscrivant, j'accepte les conditions générales de vente : ${cgvUrl}`
            : market === 'cd'
              ? `En souscrivant, j'accepte les conditions générales : ${cgvUrl}`
              : `By subscribing, I accept the Terms of Service and Sale: ${cgvUrl}`,
        },
      },
      success_url: `${front}/?billing=success`,
      cancel_url: `${front}/?billing=cancel`,
    };
    let session: Stripe.Checkout.Session;
    try {
      session = await s.checkout.sessions.create(params);
    } catch (err) {
      // Certains comptes ne permettent pas consent_collection : l'acceptation
      // reste garantie par le garde CGV en amont (dans l'app).
      if (!/terms_of_service|consent_collection|custom_text/i.test(String((err as any)?.message))) {
        req.log.warn({ err }, 'stripe checkout.sessions.create a échoué');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
      delete params.consent_collection; delete params.custom_text;
      req.log.warn('stripe: consent_collection indisponible, checkout sans case CGV');
      try {
        session = await s.checkout.sessions.create(params);
      } catch (err2) {
        req.log.warn({ err: err2 }, 'stripe checkout.sessions.create a échoué (repli)');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
    }
    return { url: session.url };
  });

  /* ---------- Portail client (Stripe ou lien de gestion Paystack) ---------- */
  app.post('/api/billing/portal', { preHandler: requireCompany }, async (req, reply) => {
    const b = await companyBilling(req.companyId!);
    // Le provider mémorisé sur l'abonnement fait foi, pas la config du
    // marché : un abonné ZA souscrit chez Stripe reste géré par Stripe
    // même après la bascule du marché vers Paystack.
    if (b.payment_provider === 'paystack') {
      if (!paystackConfigured()) return reply.code(503).send({ error: 'Facturation non configurée.' });
      if (!b.paystack_subscription_code) return reply.code(404).send({ error: 'Aucun abonnement à gérer.' });
      try {
        const r = await paystackFetch(`/subscription/${b.paystack_subscription_code}/manage/link`, { method: 'POST' });
        return { url: r.data?.link };
      } catch (err) {
        req.log.warn({ err }, 'paystack manage/link a échoué');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
    }

    const s = stripe();
    if (!s) return reply.code(503).send({ error: 'Facturation non configurée.' });
    if (!b.stripe_customer_id) return reply.code(404).send({ error: 'Aucun abonnement à gérer.' });
    let session: Stripe.BillingPortal.Session;
    try {
      session = await s.billingPortal.sessions.create({
        customer: b.stripe_customer_id,
        return_url: config.stripe.portalReturnUrl || frontUrlFor(req.market ?? 'fr'),
      });
    } catch (err) {
      req.log.warn({ err }, 'stripe billingPortal.sessions.create a échoué');
      return reply.code(502).send({ error: STRIPE_DOWN });
    }
    return { url: session.url };
  });
}
