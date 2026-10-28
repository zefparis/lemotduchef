-- Notifications Web Push (VAPID) : un abonnement par appareil du restaurateur.
-- Rien n'est envoyé sans réglage explicite ; les endpoints sont supprimés sur
-- révocation ou quand le navigateur/expéditeur les invalide (410).
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (char_length(endpoint) <= 2000),
  p256dh text NOT NULL CHECK (char_length(p256dh) <= 200),
  auth text NOT NULL CHECK (char_length(auth) <= 100),
  user_agent text NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_company_idx ON push_subscriptions(company_id);

-- Réglages par restaurant : avis concernés, heures de silence, contenu masqué.
CREATE TABLE push_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- Notifier pour les avis de note <= rating_max (3 = négatifs, 5 = tous).
  rating_max smallint NOT NULL DEFAULT 3 CHECK (rating_max BETWEEN 1 AND 5),
  quiet_start time,
  quiet_end time,
  hide_content boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
