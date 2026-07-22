# Certified Feed Service agent guide

## Read this first

This repository is a standalone, read-only TypeScript service that exposes `app.certified.feed.beta.getFeedSkeleton` over XRPC. It reads Magic Indexer's current PostgreSQL state and returns exact AT Protocol strong references. It does not ingest, hydrate, authenticate, write records, own migrations, or provide immutable event history.

Use **npm**, not pnpm. `package-lock.json` is authoritative. The package supports Node.js 22+, while CI and Docker use Node.js 24. PostgreSQL 16+ is required.

Before changing feed behavior, read these together:

- `src/feed/feed-query.sql` — primary behavioral contract
- `src/feed/query.ts` — SQL bind order and row mapping
- `test/feed.integration.test.ts` — cross-table and pagination invariants
- `docs/database-contract.md` — external Magic Indexer schema contract

## Commands

```bash
npm install                    # local setup; use npm ci for a clean reproducible install
npm run dev                    # watch TypeScript and src/feed/feed-query.sql
npm run codegen                # regenerate ignored Lexicon TypeScript
npm run check                  # strict TypeScript check
npm test                       # unit tests; equivalent to npm run test:unit
npm run build                  # codegen, compile, copy SQL, smoke-load production adapter
```

Integration tests require an explicitly chosen, empty, disposable PostgreSQL 16+ database:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration
```

To test an externally migrated Magic Indexer schema:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration:magic
```

Never point either integration command at a shared, staging, or production database. The suite creates contractual tables and test rows but does not drop or truncate existing tables. `test:integration:magic` requires `psql`, verifies the migration versions listed in `scripts/test-magic-schema.sh`, and does not apply migrations.

CI runs:

```text
npm ci -> npm run check -> npm test -> npm run test:integration -> npm run build
```

There is no configured lint or formatting command. Follow the existing style: ESM, NodeNext `.js` import suffixes, single quotes, no semicolons, narrow interfaces, and no unrelated reformatting.

## Architecture and ownership

The runtime call stack is:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed-skeleton.ts
  -> src/feed/service.ts
  -> src/feed/query.ts
  -> src/feed/feed-query.sql
  -> src/database.ts
```

- `src/server.ts` is the composition root. It owns configuration loading, listener settings, initial readiness, and graceful shutdown.
- `src/app.ts` is the fetch-compatible HTTP boundary. It owns operational routes, method checks, the 64 KiB body limit, malformed-JSON handling, and request metrics.
- `src/api/get-feed-skeleton.ts` registers the Lexicon procedure and translates expected `FeedError` values into stable public responses.
- `src/feed/service.ts` owns semantic validation, cursor decoding, repository coordination, scope-cap enforcement, `limit + 1` trimming, output shaping, and next-cursor creation.
- `src/feed/query.ts` owns the fixed SQL parameter order, execution, and database-row mapping.
- `src/feed/feed-query.sql` owns scope resolution, quality and endorsement policy, event folding/classification, ordering, and keyset pagination.
- `src/database.ts` is the only PostgreSQL pool owner. Keep database access behind the existing seams.
- `src/metrics.ts` owns an isolated Prometheus registry with bounded labels.

Prefer tests at the seam being changed: app tests fake `FeedSkeletonReader`, service tests fake `FeedQueryReader`, pure rules have unit tests, and SQL/cross-table behavior belongs in the PostgreSQL integration suite.

## Canonical and generated files

- `lexicons/**/*.json` is the committed public wire contract.
- `src/lexicons/` is generated and gitignored. Never hand-edit or commit it.
- `src/feed/feed-query.sql` is the canonical SQL statement.
- `dist/` and `coverage/` are generated and gitignored.
- `npm run build` must continue to copy the SQL beside `dist/feed/query.js` and smoke-test that the production adapter can load it.

A request, response, event-kind, or public-error change usually requires coordinated updates to the Lexicon JSON, domain types, validation/service behavior, tests, and README. Run codegen rather than editing generated output. A schema-dependent change usually requires coordinated updates to SQL, its bind mapping, integration tests, and `docs/database-contract.md`.

## Feed invariants

Preserve these unless the public contract is intentionally revised and documented:

- Omitted `authors` resolves the viewer's current `app.certified.graph.follow` records. Explicit `authors` replaces only that base, and `authors: []` means an empty base. Preserve `hasExplicitAuthors` through validation and SQL.
- Evaluator endorsement subjects are unioned after base-author resolution. The viewer is removed, candidates are deduplicated, known inactive actors are removed, and actors missing from `actor` remain eligible.
- Deduplicate request lists before enforcing semantic limits. Current limits are 500 explicit authors, 64 evaluators, 16 kinds, 500 resolved authors, and 1–50 page items.
- Omitted or empty `kinds` means all supported kinds. Unknown kinds fail with `INVALID_KIND`.
- Organization-quality policy applies to known certified organizations using only service-configured `TRUSTED_QUALITY_LABELER_DIDS`. Callers never choose label sources.
- `includeUnrated` applies only when no active trusted quality label exists. An active disallowed label is not unrated.
- Active quality assertions and negations use source, URI, value, `neg`, `cts`, and `exp` as documented in `docs/database-contract.md`.
- Scope is capped after all unions and membership filtering. Oversized scopes return their count without expanding project or eligible-event record scans, then fail with `FEED_SCOPE_TOO_LARGE`; do not silently truncate them.
- Evaluator expansion and visible endorsement events share the same rules. Require an account subject, no self-endorsement, exact definition URI and CID, `badgeType: endorsement`, allowed-issuer compliance, and the latest subject-authored response targeting the exact award URI and CID. Do not replace this with `endorsement_edge`.
- Missing `allowedIssuers` permits any issuer. An empty or malformed value permits none.
- Project/activity pairing happens before kind filtering and pagination. It requires the same actor, an exact activity URI and CID, and a `sort_at` gap strictly below 60 seconds. The collection becomes `project.created_with_cert`; the paired activity stays suppressed across page boundaries.
- Output `subject` is the exact current `{ uri, cid }` strong reference. `id` currently equals the source URI. Hydration remains downstream.
- The feed is mutable current state, not a snapshot or event log. Cursor traversal is deterministic for each query but does not provide snapshot isolation across requests.

## Ordering and cursor contract

Ordering and cursor handling are one coupled contract:

```text
effective timestamp DESC, record URI DESC
```

A valid string `json.createdAt` is parsed as `timestamptz`; missing, malformed, non-string, or PostgreSQL-invalid values fall back to `record.sort_at`. Keep `pg_input_is_valid` before casting untrusted JSON.

Pagination must use the matching descending predicate and fetch `limit + 1`. The opaque cursor is unpadded base64url JSON with exactly `{ version: 2, value, uri }`. It stores the last emitted timestamp and URI. If timestamp derivation, formatting, tie-break direction, or payload shape changes, treat that as a cursor-contract change and bump the version; old incompatible cursors must fail rather than paginate incorrectly.

## Database and operational safety

Magic Indexer owns the `record`, `actor`, and `label` schema. This repository must not apply migrations, create indexes, refresh materialized views, or write cursor state. Keep every caller-controlled SQL value parameterized. Schema or index changes belong in Magic Indexer and should be justified with production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence.

Use a deployment role with `SELECT` only. `default_transaction_read_only=on` is defense in depth, not a replacement for grants.

`GET /ready` checks reachability, PostgreSQL 16 timestamp support, and read-only session state. It intentionally does not verify Magic Indexer tables, migration completeness, or ingestion freshness. `GET /health` remains process liveness only.

`REQUEST_TIMEOUT_MS` bounds receiving the HTTP request, not total handler or query duration. Pool acquisition and PostgreSQL statement timeouts are separate controls.

Keep public errors actionable and stable. Never expose SQL, credentials, table contents, internal causes, or stack traces. Keep Prometheus labels bounded; never label metrics with DIDs, AT-URIs, CIDs, cursors, or other caller-controlled values.

Rate limiting belongs at the gateway. Keep `/health`, `/ready`, and `/metrics` private in deployment rather than adding per-replica public rate-limit state here.

## Change checklist

1. Inspect the current branch and working tree; preserve unrelated or in-flight changes.
2. Change only the owning layer and directly coupled contracts.
3. Add or update focused tests. SQL behavior requires integration coverage.
4. Update the Lexicon and public/domain documentation when behavior changes.
5. Run `npm run check`, `npm test`, and `npm run build`.
6. Run integration tests only with an explicitly selected disposable PostgreSQL database.
7. Report commands run, failures, and any validation not performed.
