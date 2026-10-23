-- Réglage « Mon style » : nouveau jeu de tons (sobre / chaleureux / direct),
-- forme d'adresse du client et expressions à éviter — persistés et transmis
-- au rédacteur à chaque génération.
-- Correspondance des anciennes valeurs : elegant → sobre, familial → chaleureux.
UPDATE restaurant_profiles SET tone='sobre' WHERE tone='elegant';
UPDATE restaurant_profiles SET tone='chaleureux' WHERE tone='familial';
ALTER TABLE restaurant_profiles DROP CONSTRAINT restaurant_profiles_tone_check;
ALTER TABLE restaurant_profiles ADD CONSTRAINT restaurant_profiles_tone_check
  CHECK (tone IN ('sobre','chaleureux','direct'));
ALTER TABLE restaurant_profiles
  ADD COLUMN address_form text NOT NULL DEFAULT 'vous' CHECK (address_form IN ('vous','tu')),
  ADD COLUMN avoid_phrases text[] NOT NULL DEFAULT '{}' CHECK (cardinality(avoid_phrases) <= 20);
