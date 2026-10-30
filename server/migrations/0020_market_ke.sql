-- Marché KE (Kenya) : élargissement des contraintes CHECK posées par 0017.
ALTER TABLE "user" DROP CONSTRAINT user_market_check;
ALTER TABLE "user" ADD CONSTRAINT user_market_check CHECK (market IN ('fr','za','ke'));
ALTER TABLE companies DROP CONSTRAINT companies_market_check;
ALTER TABLE companies ADD CONSTRAINT companies_market_check CHECK (market IN ('fr','za','ke'));
