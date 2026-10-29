-- Marché par compte et par restaurant (FR existant, ZA nouveau).
-- Le marché est fixé à l'inscription depuis le domaine (Origin/Host de la
-- requête) puis stocké : jamais fourni librement par le client après coup.
-- Il pilote langue par défaut, devise, fuseau, expéditeur des emails,
-- provider de paiement et le filtre prospection (FR seulement).

ALTER TABLE "user"
  ADD COLUMN market text NOT NULL DEFAULT 'fr' CHECK (market IN ('fr','za')),
  -- Langue de l'interface préférée ; '' = défaut du marché.
  ADD COLUMN lang text NOT NULL DEFAULT '' CHECK (lang IN ('','fr','en'));

ALTER TABLE companies
  ADD COLUMN market text NOT NULL DEFAULT 'fr' CHECK (market IN ('fr','za'));

CREATE INDEX companies_market_idx ON companies(market);
CREATE INDEX user_market_idx ON "user"(market);
