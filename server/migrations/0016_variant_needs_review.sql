-- Variantes « à relire » affichées quand même : persistance du marqueur
ALTER TABLE reply_variants ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
