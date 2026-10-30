-- Source d'arrivée du compte (?src=, référent ou « direct »), posée à
-- l'inscription : suivi d'acquisition et de conversion par marché.
ALTER TABLE "user" ADD COLUMN signup_source text NOT NULL DEFAULT '';
