# Hyperindex database switch plan

## Status

Approved implementation plan. This service has not been publicly released, so Hyperindex becomes the only supported database contract and the existing cursor remains version 1.

Before cutover, verify that Hyperindex's Tap collection filters and backfill make `org.hyperboards.board` records available. Lexicon registration alone does not prove record ingestion. If no source Hyperboard records exist yet, record live Hyperboard classification as unvalidated rather than blocking implementation.

## Goal

Switch the feed service from Magic Indexer's PostgreSQL schema to Hyperindex's PostgreSQL schema without changing the public XRPC request or response contract.

The service remains read-only. It continues to query PostgreSQL directly and does not call Hyperindex's GraphQL API, apply migrations, or write indexed data.

## Decisions

### Keep

- Direct PostgreSQL access
- The existing XRPC request and response contract
- The 500-author resolved-scope limit
- Cursor version 1
- Effective timestamp descending, then record URI descending
- Existing endorsement, organization-quality, project-pairing, and pagination rules
- The current SQL parameter order and repository result shape

### Drop

- Magic Indexer database support
- `actor.is_active`
- `actor.is_certified_organization`
- `record.sort_at`
- `record.subject_did`
- Quality-label reads from `label`
- `test:integration:magic`
- `scripts/test-magic-schema.sh`

Do not add a database-backend switch or compatibility views that make Hyperindex imitate Magic Indexer.

## Runtime call path

The call path remains unchanged:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed-skeleton.ts
  -> src/feed/service.ts
  -> src/feed/query.ts
  -> src/feed/feed-query.sql
  -> src/database.ts
```

Only the SQL-owned database behavior and its directly coupled tests, tooling, and documentation change.

## Hyperindex database contract

The feed query depends on these Hyperindex columns:

```ts
interface HyperindexRecordRow {
  readonly uri: string
  readonly cid: string
  readonly did: string
  readonly collection: string
  readonly json: unknown
  readonly indexedAt: Date
  readonly recordCreatedAt: Date | null
}

interface HyperindexExternalLabelRow {
  readonly id: bigint
  readonly src: string
  readonly uri: string
  readonly cid: string | null
  readonly val: string
  readonly neg: boolean
  readonly cts: string
  readonly exp: string | null
}
```

The effective feed timestamp is:

```ts
const effectiveAt = record.recordCreatedAt ?? record.indexedAt
```

Hyperindex owns these tables and indexes. This repository must not add migrations or indexes.

## Feed SQL changes

Update `src/feed/feed-query.sql` while preserving its existing bind order and output columns.

### Scope resolution

1. Continue selecting explicit authors when `authors` is present.
2. Continue resolving the viewer's `app.certified.graph.follow` records when `authors` is omitted.
3. Derive endorsement subjects from `award.json.subject.did` instead of `record.subject_did`.
4. Preserve the account-subject type check, DID validation, self-endorsement rejection, exact definition URI and CID match, allowed-issuer policy, and subject-response policy.
5. Stop joining `actor` for active-state filtering. Hyperindex removes records and actor rows when an identity is explicitly deleted, deactivated, suspended, or taken down.

Actors missing from `actor` remain eligible. Feed output is naturally empty when Hyperindex has purged all source records for an inactive account.

### Organization detection

Replace `actor.is_certified_organization` with existence of the exact current record:

```text
at://<did>/app.certified.actor.organization/self
```

A DID is treated as a certified organization only when that record exists with collection `app.certified.actor.organization`.

### Organization-quality labels

Read trusted account-quality labels from `external_label`, not `label`.

Match labels with:

```sql
external_label.uri = scoped.did
AND external_label.cid IS NULL
AND external_label.src = ANY(trusted_quality_labeler_dids)
```

Preserve the existing quality values and policy:

```text
high-quality
standard
draft
likely-test
```

`external_label.cts` and `external_label.exp` are text. Guard each cast with `CASE` and `pg_input_is_valid`; do not rely on boolean predicate evaluation order to protect a cast. Ignore an entire label row when `cts` or a non-null `exp` is malformed. An ignored row neither asserts nor negates a quality value, and it must not fail the feed query.

An assertion remains active when it is positive, unexpired, and has no active same-source negation for the same subject and value whose `cts` is at least the assertion's `cts`.

Before cutover, map every DID in `TRUSTED_QUALITY_LABELER_DIDS` to its intended Hyperindex subscription and verify that the subscription is healthy and caught up. Keep this as an operator check rather than adding it to `/ready`.

### Record timestamps

Use:

```sql
COALESCE(record.record_created_at, record.indexed_at)
```

for:

- Feed ordering
- Cursor values
- Project/activity pairing
- Latest endorsement-response ordering, before the existing `indexed_at` and URI tie-breakers

Hyperindex preserves a non-null `record_created_at` across record updates. `indexed_at` is the fallback for a missing or malformed top-level `createdAt`.

Before cutover, verify that every record with a service-valid top-level `createdAt` has a non-null `record_created_at`. Migration 010 adds the column and indexes, while Hyperindex startup performs the historical backfill; migration presence alone does not prove backfill completion.

### Resolved-scope cap

Create an explicitly materialized bounded scope after calculating `scope_count`:

```sql
bounded_scope AS MATERIALIZED (
  SELECT scoped.did
  FROM final_scope AS scoped
  CROSS JOIN scope_meta AS meta
  WHERE meta.scope_count <= $13
)
```

Both project pairing and eligible-event selection must start from `bounded_scope`.

This preserves the public `FeedScopeTooLarge` behavior while preventing PostgreSQL from reordering joins and probing event records for scopes over 500 DIDs.

### Repository seam

Keep these TypeScript contracts unchanged:

```ts
interface FeedQueryInput {
  readonly request: NormalizedFeedRequest
  readonly cursor?: FeedCursor
  readonly trustedQualityLabelerDids: readonly string[]
}

interface FeedQueryResult {
  readonly scopeCount: number
  readonly rows: readonly FeedQueryRow[]
}
```

`src/feed/query.ts` continues to bind the same 14 values in the same order and map the same result columns.

## Cursor contract

Keep the existing payload and version:

```ts
interface FeedCursor {
  readonly version: 1
  readonly value: string
  readonly uri: string
}
```

The cursor still stores the effective timestamp and URI of the last emitted item. The descending keyset predicate remains:

```sql
effective_at < cursor.value
OR (effective_at = cursor.value AND uri < cursor.uri)
```

Update documentation to define version 1 using Hyperindex's effective timestamp. Do not bump the version because the service and cursor contract have not been publicly released.

## Integration-test changes

Update `test/feed.integration.test.ts` to create and seed a minimal Hyperindex-compatible schema.

### Record fixture

Replace Magic Indexer-only columns with:

```text
record.uri
record.cid
record.did
record.collection
record.json
record.indexed_at
record.rkey
record.record_created_at
```

Set `record_created_at` and `indexed_at` explicitly in fixtures so ordering and fallback tests remain deterministic.

### External-label fixture

Create enough of Hyperindex's external-label schema to run the same suite against both the minimal CI database and an externally migrated Hyperindex database:

```text
label_subscription_state
external_label.id
external_label.subscription_url
external_label.seq
external_label.label_index
external_label.src
external_label.uri
external_label.cid
external_label.val
external_label.neg
external_label.cts
external_label.exp
```

Seed unique subscription sequence and label-index values and satisfy Hyperindex's foreign-key and uniqueness constraints.

### Actor and organization fixtures

- Remove the Magic Indexer actor-state fixture and `is_active` assertions.
- Represent certified organizations with `app.certified.actor.organization/self` records.
- Keep coverage proving that actors without an `actor` row remain eligible.

### Required behavioral coverage

Add or adapt tests for:

- Follow and explicit-author resolution
- Endorsement subjects extracted from JSON
- Invalid, record-target, and self-endorsements
- Exact award, definition, activity, and response CIDs
- Organization detection through the organization self record
- Bare-DID quality labels
- Ignoring record-level and CID-specific labels for account quality
- Trusted label-source filtering
- Assertion, negation, and expiration behavior
- Malformed `cts` and `exp` rows being ignored without asserting or negating quality
- `record_created_at` ordering
- `indexed_at` fallback
- Latest response ordering
- Project/activity pairing and suppression across page boundaries
- Hyperboard classification
- Equal-timestamp pagination
- Explicitly empty scope
- More than 500 resolved authors returning `FeedScopeTooLarge`

Add a PostgreSQL plan regression using `EXPLAIN (ANALYZE, FORMAT JSON)` for an oversized scope. Assert only that project and eligible source scans have zero actual loops; do not pin the complete planner tree or cost estimates.

## Compatibility tooling

Add `scripts/test-hyperindex-schema.sh` and expose:

```json
"test:integration:hyperindex": "sh scripts/test-hyperindex-schema.sh"
```

The script must:

1. Require `TEST_DATABASE_URL`.
2. State clearly that it must point to an empty, disposable database already migrated by Hyperindex.
3. Verify the required Hyperindex schema or migration versions, including `external_label`, its active lookup index, and `record.record_created_at`.
4. Run the existing integration suite without applying migrations.

Remove `scripts/test-magic-schema.sh` and `test:integration:magic`.

## Documentation changes

Update:

- `README.md`
- `docs/database-contract.md`
- `AGENTS.md`

Document:

- Hyperindex as the only supported database owner
- Required `record` and `external_label` columns
- Bare-DID account-quality labels
- Organization detection through the exact organization self record
- Hyperindex's inactive-identity purge behavior
- `record_created_at` with `indexed_at` fallback
- Cursor version 1 semantics
- The Hyperindex compatibility-test command
- Required read-only grants

The documented reader role should require only schema usage and `SELECT` on `record` and `external_label`:

```sql
GRANT USAGE ON SCHEMA public TO certified_feed_reader;
GRANT SELECT ON public.record, public.external_label
  TO certified_feed_reader;
ALTER ROLE certified_feed_reader
  SET default_transaction_read_only = on;
```

Keep `/ready` limited to connectivity, PostgreSQL capability, and read-only session checks. Do not add runtime schema or ingestion-freshness checks.

## Validation

Run the normal repository checks:

```bash
npm run check
npm test
npm run build
```

Run the integration suite against an empty disposable PostgreSQL database:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration
```

Run compatibility coverage against an empty database migrated by Hyperindex:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration:hyperindex
```

Never run either integration command against a shared, staging, or production database because the suite creates contractual tables and inserts test records.

Use read-only query plans against the current Hyperindex database for:

- Explicit authors
- Followed authors
- Evaluator expansion
- Organization-quality filtering
- An oversized author scope
- Hyperboard events

Record the commands, timings, index usage, and anything not validated.

## Acceptance criteria

- The feed query prepares and executes against the supported Hyperindex schema.
- No runtime query references Magic Indexer-only columns or `label`.
- The public XRPC request, response, errors, event kinds, and 500-author limit are unchanged.
- Cursor version remains 1 and pagination remains deterministic.
- Oversized scopes do not execute project or eligible-event record scans.
- Organization-quality filtering uses trusted bare-DID labels from `external_label`.
- Integration coverage proves that indexed Hyperboards appear as `hyperboard.create` events; live classification is recorded as unvalidated when the target database has no source Hyperboard records.
- Unit, integration, type-check, and production-build checks pass.
- Documentation and compatibility tooling describe Hyperindex only.
