#!/usr/bin/env sh
set -eu

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo 'TEST_DATABASE_URL is required; point it at an empty disposable database already migrated by Magic Indexer.' >&2
  exit 1
fi

required_versions='003 014 025 037 041'
for version in $required_versions; do
  applied="$(psql "$TEST_DATABASE_URL" -X -Atqc "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$version')")"
  if [ "$applied" != 't' ]; then
    echo "Magic Indexer migration $version is missing; apply the current Magic Indexer migration set before running this compatibility test." >&2
    exit 1
  fi
done

npm run test:integration
