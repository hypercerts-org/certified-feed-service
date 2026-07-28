#!/usr/bin/env sh
set -eu

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo 'TEST_DATABASE_URL is required; point it at a disposable database whose schema was migrated by Hyperindex and which contains no application rows.' >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo 'psql is required to verify the Hyperindex schema; install the PostgreSQL client and retry.' >&2
  exit 1
fi

query() {
  psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "$1"
}

required_versions='001 002 007 008 010'
for version in $required_versions; do
  applied="$(query "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$version')")"
  if [ "$applied" != 't' ]; then
    echo "Hyperindex migration $version is missing; migrate this disposable database with the current Hyperindex release before retrying." >&2
    exit 1
  fi
done

require_column() {
  table_name="$1"
  column_name="$2"
  expected_type="$3"
  actual_type="$(query "
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = '$table_name'
      AND column_name = '$column_name'
  ")"
  if [ "$actual_type" != "$expected_type" ]; then
    echo "Hyperindex schema mismatch: public.$table_name.$column_name must have type $expected_type (found ${actual_type:-missing})." >&2
    exit 1
  fi
}

require_column record uri text
require_column record cid text
require_column record did text
require_column record collection text
require_column record json jsonb
require_column record indexed_at 'timestamp with time zone'
require_column record rkey text
require_column record record_created_at 'timestamp with time zone'
require_column actor did text
require_column actor handle text
require_column actor indexed_at 'timestamp with time zone'

rkey_generated="$(query "
  SELECT is_generated
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'record'
    AND column_name = 'rkey'
")"
if [ "$rkey_generated" != 'ALWAYS' ]; then
  echo 'Hyperindex schema mismatch: public.record.rkey must be a generated column from migration 002.' >&2
  exit 1
fi

require_column label_subscription_state url text
require_column external_label id bigint
require_column external_label subscription_url text
require_column external_label seq bigint
require_column external_label label_index integer
require_column external_label src text
require_column external_label uri text
require_column external_label cid text
require_column external_label val text
require_column external_label neg boolean
require_column external_label cts text
require_column external_label exp text

active_lookup_index="$(query "
  SELECT EXISTS (
    SELECT 1
    FROM pg_index AS index
    JOIN pg_class AS index_relation
      ON index_relation.oid = index.indexrelid
    JOIN pg_class AS table_relation
      ON table_relation.oid = index.indrelid
    JOIN pg_namespace AS namespace
      ON namespace.oid = table_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_relation.relname = 'external_label'
      AND index_relation.relname = 'idx_external_label_active_lookup'
      AND regexp_replace(
        pg_get_indexdef(index.indexrelid),
        '[[:space:]]+',
        ' ',
        'g'
      ) LIKE '%(uri, val, src, cid, cts DESC, id DESC)%'
  )
")"
if [ "$active_lookup_index" != 't' ]; then
  echo 'Hyperindex schema mismatch: public.external_label is missing the migration-008 active lookup index on (uri, val, src, cid, cts DESC, id DESC).' >&2
  exit 1
fi

npm run test:integration
