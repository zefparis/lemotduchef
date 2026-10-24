-- Sécurité : état de traitement des événements Stripe (processing → done,
-- dans la même transaction que le traitement) et des générations LLM
-- (running → ok | failed ; chaque appel fournisseur est débité du quota).

ALTER TABLE stripe_events
  ADD COLUMN status text NOT NULL DEFAULT 'done' CHECK (status IN ('processing','done'));

ALTER TABLE generations
  ADD COLUMN status text NOT NULL DEFAULT 'ok' CHECK (status IN ('running','ok','failed'));
