-- Provider de paiement par entreprise : 'stripe' aujourd'hui, 'paystack'
-- pour les nouveaux abonnements ZA quand le marché basculera (les
-- abonnés Stripe existants restent gérés par Stripe jusqu'à résiliation).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'stripe';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS paystack_subscription_code text;

-- Idempotence des webhooks Paystack (même contrat que stripe_events).
CREATE TABLE IF NOT EXISTS paystack_events (
  event_id text PRIMARY KEY,
  type text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'processing',
  processed_at timestamptz
);
