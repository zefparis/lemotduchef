-- Générations « non décomptées » : moins de 2 variantes utilisables
ALTER TABLE generations DROP CONSTRAINT generations_status_check;
ALTER TABLE generations ADD CONSTRAINT generations_status_check
  CHECK (status IN ('running','ok','failed','unbilled'));
