-- Preserve configured limits and all request attempts when switching enforcement off.
-- enabled=true with a zero limit still means stopped; enabled=false disables only quantity limits.
ALTER TABLE budgets ADD COLUMN enabled boolean NOT NULL DEFAULT true;
