-- Réponses multilingues : langue détectée de l'avis, langue de la
-- génération, traduction affichable de chaque variante.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS lang text;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS lang text NOT NULL DEFAULT 'fr';
ALTER TABLE reply_variants ADD COLUMN IF NOT EXISTS translation text;
