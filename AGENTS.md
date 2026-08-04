# Certified Feed Service agent guide

## Read this first

This repository is a standalone, read-only TypeScript service that exposes `app.certified.feed.beta.getFeedSkeleton` over XRPC. It reads Hyperindex's current PostgreSQL state and returns exact AT Protocol strong references. It does not ingest, hydrate, authenticate, write records, own migrations, or provide immutable event history.

Use **npm**, not pnpm. `package-lock.json` is authoritative. The package supports Node.js 22+, while CI and Docker use Node.js 24. PostgreSQL 16+ is required.

Before changing feed behavior, read these together:

- `src/feed/feed-query.sql` — primary behavioral contract
- `src/feed/query.ts` — SQL bind order and row mapping
- `test/feed.integration.test.ts` — cross-table and pagination invariants
- `docs/database-contract.md` — external Hyperindex schema contract

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

To test an externally migrated Hyperindex schema:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration:hyperindex
```

Never point either integration command at a shared, staging, or production database. The suite creates contractual tables and test rows but does not drop or truncate existing tables. `test:integration:hyperindex` requires `psql`, verifies the Hyperindex migrations and schema listed in `scripts/test-hyperindex-schema.sh`, and does not apply migrations.

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
  -> src/feed/registry.ts
  -> src/feed/sql-feed.ts
  -> src/feed/query.ts
  -> src/feed/feed-query.sql
  -> src/database.ts
```

- `src/server.ts` is the composition root. It owns configuration loading, listener settings, initial readiness, and graceful shutdown.
- `src/app.ts` is the fetch-compatible HTTP boundary. It owns operational routes, method checks, the 64 KiB body limit, malformed-JSON handling, and request metrics.
- `src/api/get-feed-skeleton.ts` registers the Lexicon procedure and translates expected `FeedError` values into stable public responses.
- `src/feed/service.ts` projects one registry-selected metadata page into the public skeleton.
- `src/feed/registry.ts` owns static feed lookup, duplicate-ID rejection, feed/params compatibility, and the shared metadata/source page interface.
- `src/feed/sql-feed.ts` owns the generic SQL-feed execution order: parse and normalize registered params, decode the feed-scoped cursor, bind and time one query, map rows, trim `limit + 1`, record result metrics, and encode the next cursor.
- `src/feed/query.ts` owns the current Certified feed definition, generated structural parser, semantic normalizer selection, fixed SQL bind order, and fail-fast metadata/source row mapping.
- `src/feed/cursor.ts` owns the versioned feed-scoped envelope and reusable or feed-specific cursor codecs.
- `src/feed/feed-query.sql` owns current Certified scope resolution, quality and endorsement policy, event folding/classification, ordering, keyset pagination, and the conditional exact-source join after pagination.
- `src/database.ts` is the only PostgreSQL pool owner. Keep database access behind the existing seams.
- `src/metrics.ts` owns an isolated Prometheus registry with bounded labels.

Prefer tests at the narrowest owner: app tests fake `FeedSkeletonReader`; service tests fake `FeedPageLoader`; registry tests fake `RegisteredFeed`; `defineSqlFeed` and current-definition tests fake the query executor; pure rules have unit tests; SQL/cross-table behavior belongs in the PostgreSQL integration suite.

## Canonical and generated files

- `lexicons/**/*.json` is the committed public wire contract.
- `src/lexicons/` is generated and gitignored. Never hand-edit or commit it.
- `src/feed/feed-query.sql` is the canonical current Certified feed statement. SQL assets are explicitly registered; never discover executable feed SQL from caller input or the filesystem.
- `dist/` and `coverage/` are generated and gitignored.
- `@atproto/lex@0.3.0` emits an explicit `CertifiedFeedParams` schema generic that conflicts with `exactOptionalPropertyTypes`. `npm run codegen` therefore runs `scripts/fix-generated-feed-defs.mjs` to remove exactly that generated generic. Keep this workaround narrow and remove it when the generator supports exact optional properties.
- `npm run build` must continue to copy the SQL beside `dist/feed/query.js` and smoke-test that the production adapter can load it.

A request, response, event-kind, or public-error change usually requires coordinated updates to the Lexicon JSON, domain types, validation/service behavior, tests, and README. Run codegen rather than editing generated output. A schema-dependent change usually requires coordinated updates to SQL, its bind mapping, integration tests, and `docs/database-contract.md`.

## Feed invariants

Preserve these unless the public contract is intentionally revised and documented:

- The public request requires `feedId` and open-union `params`. The current static registration pairs `app.certified.feed.beta.defs#certifiedFeed` with `app.certified.feed.beta.defs#certifiedFeedParams`; reject duplicate configured IDs at startup and unknown feeds, feed/params mismatches, structural failures, semantic failures, and cursor failures before database access.
- Feed definitions are plain `defineSqlFeed()` objects, not mandatory classes. A definition owns its params parser/normalizer, SQL binder, cursor codec, and row mapper; definitions may reuse those functions but the registry stores only the finished `RegisteredFeed` execution closure.
- The base scope always resolves from the viewer's current `app.certified.graph.follow` records. There is no caller-supplied author override.
- Evaluator endorsement subjects are unioned after base-author resolution. The viewer is removed and candidates are deduplicated. Do not query actor status: Hyperindex purges source records for explicitly deleted, deactivated, suspended, or taken-down identities, and actors missing from `actor` remain eligible.
- Deduplicate request lists before enforcing semantic limits. Current limits are 64 evaluators, 16 kinds, and 1–50 page items.
- Omitted or empty `kinds` means all supported kinds. Unknown kinds fail with `InvalidKind`.
- Organization-quality policy applies to known certified organizations using only service-configured `TRUSTED_QUALITY_LABELER_DIDS`. Callers never choose label sources.
- `includeUnrated` applies only when no active trusted quality label exists. An active disallowed label is not unrated.
- Organization status comes only from the exact `at://<did>/app.certified.actor.organization/self` record. Active quality assertions and negations are trusted bare-DID, non-CID `external_label` rows as documented in `docs/database-contract.md`; malformed text timestamps are ignored safely.
- Materialize the complete resolved scope once for project pairing and event selection. Do not cap or truncate followed or evaluator-expanded accounts.
- Evaluator expansion and visible endorsement events share the same rules. Require an account subject, no self-endorsement, exact definition URI and CID, `badgeType: endorsement`, allowed-issuer compliance, and the latest subject-authored response targeting the exact award URI and CID. Do not replace this with `endorsement_edge`.
- Missing `allowedIssuers` permits any issuer. An empty or malformed value permits none.
- Project/activity pairing happens before kind filtering and pagination. It requires the same actor, an exact activity URI and CID, and an effective timestamp gap strictly below 60 seconds. The collection becomes `project.created_with_cert`; the paired activity stays suppressed across page boundaries.
- Output `subject` is the exact current `{ uri, cid }` strong reference. `id` currently equals the source URI. Hydration remains downstream.
- The feed is mutable current state, not a snapshot or event log. Cursor traversal is deterministic for each query but does not provide snapshot isolation across requests.

## Ordering and cursor contract

Ordering and cursor handling are one coupled contract:

```text
effective timestamp DESC, record URI DESC
```

The effective timestamp is `COALESCE(record.record_created_at, record.indexed_at)`. Hyperindex materializes valid top-level `createdAt` values and preserves them across updates. Keep `pg_input_is_valid` guards around every cast of untrusted `external_label.cts` and `external_label.exp` text.

Pagination must use the matching descending predicate and fetch `limit + 1`. The opaque cursor is unpadded base64url JSON with exactly `{ version: 1, feedId, value }`; the current timestamp/URI codec stores `{ value, uri }` inside the envelope's `value`. Decode must reject another feed's cursor before database access. Because this contract is still pre-release, version 1 begins with this feed-scoped shape. After release, any incompatible envelope or position change requires a version bump.

## Database and operational safety

Hyperindex owns the `record` and `external_label` schema. This repository must not apply migrations, create indexes, refresh materialized views, or write cursor state. Keep every caller-controlled SQL value parameterized. Schema or index changes belong in Hyperindex and should be justified with production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence.

Use a deployment role with `SELECT` only. `default_transaction_read_only=on` is defense in depth, not a replacement for grants.

`GET /ready` checks reachability, PostgreSQL 16 timestamp support, and read-only session state. It intentionally does not verify Hyperindex tables, migration completeness, external-label subscription health, backfill completion, or ingestion freshness. `GET /health` remains process liveness only.

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
