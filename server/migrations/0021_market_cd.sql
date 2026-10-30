-- Marché CD (RDC) : élargissement des contraintes CHECK.
ALTER TABLE "user" DROP CONSTRAINT user_market_check;
ALTER TABLE "user" ADD CONSTRAINT user_market_check CHECK (market IN ('fr','za','ke','cd'));
ALTER TABLE companies DROP CONSTRAINT companies_market_check;
ALTER TABLE companies ADD CONSTRAINT companies_market_check CHECK (market IN ('fr','za','ke','cd'));
