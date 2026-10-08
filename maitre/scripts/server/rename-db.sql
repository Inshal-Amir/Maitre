-- One-time move of the databases from the product's old name to Maitre. Safe to run again: every step checks first.
-- Run as the Postgres superuser, connected to the "postgres" database, with the platform and gateway stopped:
--   psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f rename-db.sql
-- Role passwords are set again by start.sh (renaming a role clears an MD5 password).

SELECT format('ALTER DATABASE %I RENAME TO %I', o, n)
FROM (VALUES ('zehnora_platform', 'maitre_platform'), ('zehnora_litellm', 'maitre_litellm')) AS t(o, n)
WHERE EXISTS (SELECT FROM pg_database WHERE datname = o) AND NOT EXISTS (SELECT FROM pg_database WHERE datname = n)\gexec

SELECT format('ALTER ROLE %I RENAME TO %I', o, n)
FROM (VALUES ('zehnora_platform', 'maitre_platform'), ('zehnora_litellm', 'maitre_litellm')) AS t(o, n)
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = o) AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = n)\gexec

SELECT EXISTS (SELECT FROM pg_database WHERE datname = 'maitre_platform') AS has_platform,
       EXISTS (SELECT FROM pg_database WHERE datname = 'maitre_litellm') AS has_litellm \gset

\if :has_platform
\connect maitre_platform
UPDATE model_catalog SET alias = 'maitre-coder', description = replace(description, 'Zehnora', 'Maitre')
  WHERE alias = 'zehnora-coder' AND NOT EXISTS (SELECT FROM model_catalog WHERE alias = 'maitre-coder');
UPDATE api_keys SET allowed_models = array_replace(allowed_models, 'zehnora-coder', 'maitre-coder')
  WHERE 'zehnora-coder' = ANY (allowed_models);
UPDATE playground_conversations SET model_alias = 'maitre-coder' WHERE model_alias = 'zehnora-coder';
UPDATE inference_requests SET model_alias = 'maitre-coder' WHERE model_alias = 'zehnora-coder';
\endif

\if :has_litellm
\connect maitre_litellm
SELECT to_regclass('"LiteLLM_VerificationToken"') IS NOT NULL AS has_tokens \gset
\if :has_tokens
UPDATE "LiteLLM_VerificationToken" SET models = array_replace(models, 'zehnora-coder', 'maitre-coder')
  WHERE 'zehnora-coder' = ANY (models);
\endif
\endif
