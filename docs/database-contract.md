# Database contract

The feed service reads the indexer's current-state tables directly. This document is the runtime schema contract between independently deployed repositories.

## Readiness checks

`/ready` intentionally does not inspect the indexer's tables, columns, or data shape. It checks that the database is reachable, runs PostgreSQL 16 or newer, supports `pg_input_is_valid` for safe `createdAt` parsing, and has a read-only session. The feed query still depends on the supported schema documented below; query failures or missing runtime columns are not converted into readiness failures.

## Supported schema

The current adapter targets the Magic Indexer Postgres shape that includes:

```text
record.uri                 text
record.cid                 text
record.did                 text
record.collection          text
record.json                jsonb
record.sort_at             timestamptz
record.indexed_at          timestamptz
record.subject_did         text

actor.did                  text
actor.is_active            boolean
actor.is_certified_organization boolean

label.uri                  text
label.src                  text
label.val                  text
label.neg                  boolean
label.cts                  timestamptz
label.exp                  timestamptz
```

These columns are present after Magic Indexer's organization flag migration, currently migration 041 or later. Production should use the current migration set so the follow, response, actor-state, and record-order indexes are also available.

Postgres 16+ is required because createdAt ordering uses `pg_input_is_valid` before casting untrusted JSON text to `timestamptz`. This preserves the required malformed-value fallback without introducing a database function or migration.

## Required collections

```text
app.certified.graph.follow
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

Missing rows produce a smaller feed. They do not make readiness fail, and readiness does not verify schema shape or ingestion completeness.

## Query ownership

`src/feed/query.ts` owns one parameterized CTE statement with these stages:

1. Choose explicit authors or current Certified outbound follows.
2. Resolve current evaluator endorsement subjects directly from `record`.
3. Union, deduplicate, remove the viewer, and remove known inactive actors.
4. Apply trusted active organization-quality labels.
5. Count and cap the final author scope.
6. Calculate project/activity pairs independently of page boundaries.
7. Select and classify eligible source records.
8. Apply final kind and keyset filters.
9. Order by valid `createdAt` (falling back to `sort_at`) descending with URI descending as the tie-breaker, then fetch `limit + 1`.

Only fixed collection and event-kind constants appear in SQL text. Every request-controlled value is a bind parameter.

## Active label semantics

A quality assertion is active when:

- `neg = false`;
- `exp` is absent or in the future;
- no active negation from the same source for the same URI and value has `cts >=` the assertion's `cts`.

An expired negation does not cancel an assertion. A later active negation does. The feed query intentionally uses the six label columns in the public database contract and does not depend on label history IDs or CIDs.

Only labels from `TRUSTED_QUALITY_LABELER_DIDS` count. Labels are matched against:

```text
at://<organization DID>/app.certified.actor.organization/self
```

## Project pairing semantics

A collection and activity form a `project.created_with_cert` event only when they have the same author, their `sort_at` values are less than 60 seconds apart, and the collection item matches both the activity URI and CID. A stale strong reference does not suppress the current activity version.

## Endorsement semantics

Evaluator expansion and endorsement feed events both require:

- an account subject represented by `app.certified.defs#did`; record-target awards do not expand the record owner's account;
- issuer and subject to differ;
- a linked current `app.certified.badge.definition` whose URI and CID match the award's strong reference and whose `badgeType` is `endorsement`;
- a response targets the exact award URI and CID; an older response for the same URI does not affect the current award;
- when `allowedIssuers` is present, the award issuer must be listed exactly; an empty array excludes all issuers and malformed non-array values fail closed;
- a latest non-empty subject-authored response other than `rejected`, or no response. Latest-response ordering is `sort_at DESC`, then `indexed_at DESC`, then URI descending.

The query intentionally does not use the periodically refreshed `endorsement_edge` materialized view.

## Read-only enforcement

The deployment role should have `SELECT` only on `record`, `actor`, and `label`. The Node pool additionally sends:

```text
-c default_transaction_read_only=on
```

`/ready` fails when the session is not read-only. The service never applies migrations, creates indexes, refreshes materialized views, or writes cursor state.

## Performance verification

Before production traffic, run the statement from `src/feed/query.ts` through:

```sql
EXPLAIN (ANALYZE, BUFFERS)
```

Use production-shaped counts and the worst allowed 500-account scope. In particular, inspect:

- project/activity JSON array traversal;
- the computed createdAt timestamp expression;
- evaluator award and response probes;
- active quality-label lookups.

Do not add an index from this repository. Query-plan evidence should result in a Magic Indexer migration because Magic Indexer owns this schema.
