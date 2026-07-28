# Database contract

The feed service reads Hyperindex's current PostgreSQL state directly. This document is the runtime schema contract between independently deployed repositories. Hyperindex is the only supported database owner.

## Readiness checks

`/ready` intentionally does not inspect Hyperindex tables, columns, migrations, subscription health, backfill state, or ingestion freshness. It checks that the database is reachable, runs PostgreSQL 16 or newer, supports `pg_input_is_valid` for safe external-label timestamp parsing, and has a read-only session. Missing runtime columns or incompatible data still fail the feed query rather than readiness.

## Supported schema

The adapter uses Hyperindex's PostgreSQL schema after the external-label and record-timeline migrations. Runtime queries directly read these columns:

```text
record.uri                 text
record.cid                 text
record.did                 text
record.collection          text
record.json                jsonb
record.indexed_at          timestamptz
record.record_created_at   timestamptz, nullable

actor.did                  text
actor.handle               text, nullable

external_label.src         text
external_label.uri         text
external_label.cid         text, nullable
external_label.val         text
external_label.neg         boolean
external_label.cts         text
external_label.exp         text, nullable
```

The compatibility preflight additionally verifies `actor.indexed_at`, `external_label.id`, and migration-owned supporting columns and indexes. Hyperindex migration `002` supplies the generated `record.rkey` column used by the shared compatibility fixture. Migration `007` creates `label_subscription_state` and `external_label`; migration `008` creates `idx_external_label_active_lookup`; migration `010` adds `record.record_created_at` and its timeline indexes.

Hyperindex owns these tables, migrations, indexes, and historical backfills. This repository must not apply migrations or create compatibility views or indexes.

PostgreSQL 16+ is required because the query uses `pg_input_is_valid` before casting untrusted `external_label.cts` and `external_label.exp` text to `timestamptz`.

## Required collections

```text
app.certified.graph.follow
app.certified.actor.organization
app.certified.actor.profile
app.bsky.actor.profile
org.hypercerts.claim.activity
org.hypercerts.collection
org.hypercerts.context.evaluation
org.hypercerts.context.measurement
org.hypercerts.context.attachment
org.hyperboards.board
app.certified.badge.award
app.certified.badge.definition
app.certified.badge.response
```

Missing source-event rows produce a smaller feed. Missing identity rows do not remove selected items: hydration prefers a meaningful valid Certified profile, then a valid Bluesky profile, then a valid stored Hyperindex handle, then a DID-only summary. Missing rows do not make readiness fail, and readiness does not verify collection filters, profile availability, or ingestion completeness.

## Query ownership

`src/feed/feed-query.sql` owns one parameterized CTE statement, while `src/feed/query.ts` owns parameter binding, execution, and result mapping. The statement has these stages:

1. Choose explicit authors or current Certified outbound follows.
2. Resolve current evaluator endorsement subjects from award JSON.
3. Union, deduplicate, and remove the viewer.
4. Detect organizations from exact organization self records and apply trusted active account-quality labels.
5. Count the final author scope and materialize a bounded scope only when it contains at most 500 DIDs.
6. Calculate project/activity pairs independently of page boundaries.
7. Select and classify eligible source records.
8. Apply final kind and keyset filters.
9. Order by `COALESCE(record_created_at, indexed_at)` descending with URI descending as the tie-breaker, then fetch `limit + 1`.
10. For source-aware pages only, join the final URI/CID page rows back to `record` and return their exact collection and JSON values.

Only fixed collection and event-kind constants appear in SQL text. Every request-controlled value is a bind parameter. Source JSON is not carried through candidate classification or sorting; the conditional exact join happens only after `paged_events` applies ordering and `LIMIT`. Metadata pages execute the same statement with source retrieval disabled.

Source-aware pages select at most `limit + 1` rows but do not byte-bound their source JSON. Hydration validates each selected source against its trusted collection and feed kind, omits invalid sources without refilling, and advances the cursor from the selected source page. Feed selection and exact source retrieval share one PostgreSQL statement snapshot; a missing or mismatched URI/CID/collection join is an internal invariant failure.

`src/hydration/identity.ts` performs one later current-state batch for event actors and endorsement subjects from validated selected sources. Starting from the requested DIDs, it left-joins `actor` for `did` and `handle`, then independently joins deterministic current `app.certified.actor.profile/self` and `app.bsky.actor.profile/self` records. Every requested DID receives a context; missing rows degrade to handle-only or DID-only identity, while a rejected query fails the request. Empty or entirely invalid selected pages skip identity retrieval.

## Identity lifecycle and organization detection

The feed-selection query does not read `actor`; only the later identity batch reads `actor.did` and `actor.handle`. Hyperindex removes records and actor rows when an identity is explicitly deleted, deactivated, suspended, or taken down. Actors without an `actor` row remain eligible; an inactive identity naturally produces no feed events after Hyperindex purges its source records.

A DID is a certified organization only when `record` contains this exact current record:

```text
at://<DID>/app.certified.actor.organization/self
```

The row must have collection `app.certified.actor.organization`. Other records in that collection do not classify the DID as an organization.

## Active account-quality labels

Only labels from service-configured `TRUSTED_QUALITY_LABELER_DIDS` count. Account labels are matched as bare-DID subjects:

```text
external_label.uri = <organization DID>
external_label.cid IS NULL
```

Record-level subjects and CID-specific labels do not affect organization quality.

A quality assertion is active when:

- `neg = false`;
- `cts` parses as `timestamptz`;
- `exp` is absent or parses as a future `timestamptz`;
- no active same-source negation for the same DID and value has `cts >=` the assertion's `cts`.

A row with malformed `cts`, or malformed non-null `exp`, is ignored completely. It neither asserts nor negates a quality value and does not fail the query. An expired negation does not cancel an assertion. A later active negation does.

Before cutover, map every trusted labeler DID to its intended Hyperindex label subscription and verify that each required subscription is healthy and caught up. This is an operator check, not a readiness check.

## Record timestamps and cursor semantics

The effective feed timestamp is:

```sql
COALESCE(record.record_created_at, record.indexed_at)
```

Hyperindex materializes a valid top-level `createdAt` into `record_created_at` and preserves a non-null value across record updates. `indexed_at` is the fallback when the record lacks a valid creation timestamp.

The same effective timestamp is used for feed ordering, cursor values, project/activity pairing, and latest endorsement-response ordering. Response ordering uses the effective timestamp first, then `indexed_at`, then URI descending.

Cursor version 1 contains exactly `{ version: 1, value, uri }`. Its descending keyset predicate is:

```sql
effective_at < cursor.value
OR (effective_at = cursor.value AND uri < cursor.uri)
```

Cursor traversal is deterministic for a query but does not provide snapshot isolation while Hyperindex state changes.

Before cutover, verify that every existing record with a service-valid top-level `createdAt` has a non-null `record_created_at`. Migration `010` adds the column and indexes, while Hyperindex startup performs the historical backfill; migration presence alone does not prove backfill completion.

## Project pairing semantics

A collection and activity form a `project.created_with_cert` event only when they have the same author, their effective timestamps are strictly less than 60 seconds apart, and the collection item matches both the activity URI and CID. A stale strong reference does not suppress the current activity version.

## Endorsement semantics

Evaluator expansion and endorsement feed events both require:

- an account subject represented by `app.certified.defs#did`; record-target awards do not expand the record owner's account;
- a valid bounded DID read from `award.json.subject.did`;
- issuer and subject to differ;
- a linked current `app.certified.badge.definition` whose URI and CID match the award's strong reference and whose `badgeType` is `endorsement`;
- a response that targets the exact award URI and CID; a response for an older CID does not affect the current award;
- when `allowedIssuers` is present, the award issuer must be listed exactly; an empty array excludes all issuers and malformed non-array values fail closed;
- a latest non-empty subject-authored response other than `rejected`, or no response.

The query intentionally does not use Hyperindex's derived endorsement adjacency data.

## Read-only enforcement

The deployment role needs only schema usage and `SELECT` on the three runtime tables:

```sql
GRANT USAGE ON SCHEMA public TO certified_feed_reader;
GRANT SELECT ON public.record, public.actor, public.external_label
  TO certified_feed_reader;
ALTER ROLE certified_feed_reader
  SET default_transaction_read_only = on;
```

Grant `CONNECT` on the selected database separately when required by the deployment. The Node pool also enables `default_transaction_read_only=on`; that setting is defense in depth, not a replacement for least-privilege grants.

## Compatibility and performance verification

Run the integration suite through `npm run test:integration:hyperindex` against a disposable database already migrated by Hyperindex and otherwise empty of application rows. The command checks required migrations, record/actor/external-label columns, the generated `rkey`, and the external-label active lookup index before running the shared behavior suite. It does not apply migrations.

Before production traffic, use `EXPLAIN (ANALYZE, BUFFERS)` with production-shaped data for explicit authors, followed authors, evaluator expansion, organization-quality filtering, an oversized scope, and Hyperboard events. Capture both metadata and source-aware feed modes plus the identity batch. Verify that the source JSON join stays after pagination, identity joins remain DID-bounded, and oversized scopes do not execute project or eligible-event source scans.

Do not add an index from this repository. Query-plan evidence should result in a Hyperindex migration because Hyperindex owns the schema.
