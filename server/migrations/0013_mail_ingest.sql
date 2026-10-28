-- Ingestion des avis par email (transfert des notifications « nouvel avis »
-- de Google vers avis+<code>@lemotduchef.fr). Le code identifie le restaurant.
ALTER TABLE companies ADD COLUMN ingest_code text CHECK (char_length(ingest_code) <= 16);
CREATE UNIQUE INDEX companies_ingest_code_idx ON companies(ingest_code) WHERE ingest_code IS NOT NULL;

-- Les avis ingérés par email prennent la source 'email'.
ALTER TABLE reviews DROP CONSTRAINT reviews_source_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_source_check CHECK (source IN ('manual','google','email'));
