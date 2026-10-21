-- Option du restaurateur : autoriser l'affichage de son téléphone dans les
-- réponses publiques (désactivée par défaut — l'email de contact suffit).
ALTER TABLE restaurant_profiles ADD COLUMN IF NOT EXISTS show_phone boolean NOT NULL DEFAULT false;
