-- Confirmations de règle de transfert Gmail reçues sur avis+<code>@.
-- Affichées au restaurateur dans son espace : action manuelle, jamais visitées.
CREATE TABLE ingest_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL DEFAULT '' CHECK (char_length(code) <= 60),
  link text NOT NULL DEFAULT '' CHECK (char_length(link) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_confirmations_company_idx ON ingest_confirmations(company_id, created_at DESC);
