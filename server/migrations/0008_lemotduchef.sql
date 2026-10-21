-- Le Mot du Chef : retrait de la logique « devis » héritée du socle et mise en
-- place du métier « réponses aux avis Google ». Isolation par restaurant
-- (table companies = compte restaurant, conserve la facturation Stripe).

DROP TABLE IF EXISTS followups;
DROP TABLE IF EXISTS quotes;
DROP TABLE IF EXISTS company_settings;

ALTER TABLE companies
  DROP COLUMN IF EXISTS siren,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS contact_email,
  DROP COLUMN IF EXISTS logo_data,
  DROP COLUMN IF EXISTS logo_mime;

-- Plus d'offre Équipe : Gratuit ou Pro.
UPDATE companies SET plan='pro' WHERE plan='team';
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_check;
ALTER TABLE companies ADD CONSTRAINT companies_plan_check CHECK (plan IN ('free','pro'));

-- Profil du restaurant : tout ce dont le rédacteur (LLM) a besoin, rien de plus.
CREATE TABLE restaurant_profiles (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  city text NOT NULL DEFAULT '' CHECK (char_length(city) <= 100),
  cuisine text NOT NULL DEFAULT '' CHECK (char_length(cuisine) <= 100),
  signature_name text NOT NULL DEFAULT '' CHECK (char_length(signature_name) <= 80),
  signature_role text NOT NULL DEFAULT '' CHECK (char_length(signature_role) <= 80),
  tone text NOT NULL DEFAULT 'chaleureux' CHECK (tone IN ('chaleureux','elegant','familial')),
  strengths text[] NOT NULL DEFAULT '{}' CHECK (cardinality(strengths) <= 8),
  practical_info text NOT NULL DEFAULT '' CHECK (char_length(practical_info) <= 300),
  google_maps_url text NOT NULL DEFAULT '' CHECK (char_length(google_maps_url) <= 500),
  google_review_url text NOT NULL DEFAULT '' CHECK (char_length(google_review_url) <= 500),
  contact_email text NOT NULL DEFAULT '' CHECK (char_length(contact_email) <= 200),
  contact_phone text NOT NULL DEFAULT '' CHECK (char_length(contact_phone) <= 30),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Avis saisis par le restaurateur (source manual) ou, en V2, lus depuis
-- l'API Google Business Profile (source google, external_id = nom de ressource).
-- Données personnelles minimales : prénom affiché + texte ; purgés après
-- REVIEW_RETENTION_MONTHS (body_purged_at).
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','google')),
  external_id text,
  author_name text NOT NULL DEFAULT '' CHECK (char_length(author_name) <= 80),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  visited_on date,
  context_tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(context_tags) <= 8),
  context_note text NOT NULL DEFAULT '' CHECK (char_length(context_note) <= 300),
  -- Indicateurs « avis potentiellement contraire aux règles Google » (calculés serveur).
  flags text[] NOT NULL DEFAULT '{}',
  -- Réponse finalement publiée sur Google (cochée manuellement par le restaurateur).
  published_reply text CHECK (published_reply IS NULL OR char_length(published_reply) <= 2000),
  published_at timestamptz,
  body_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_company_external_idx ON reviews(company_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX reviews_company_created_idx ON reviews(company_id, created_at DESC);
CREATE INDEX reviews_purge_idx ON reviews(created_at) WHERE body_purged_at IS NULL;

-- Une génération = un appel LLM = 3 variantes. Sert au quota mensuel Gratuit
-- et à la journalisation du coût (tokens).
CREATE TABLE generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generations_company_month_idx ON generations(company_id, created_at DESC);

CREATE TABLE reply_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idx smallint NOT NULL CHECK (idx BETWEEN 0 AND 2),
  text text NOT NULL CHECK (char_length(text) <= 2000),
  warnings text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reply_variants_review_idx ON reply_variants(review_id);

-- Texte des supports de collecte (chevalet, encart) personnalisable par restaurant.
CREATE TABLE collect_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 60),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);
