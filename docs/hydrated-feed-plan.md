# Hydrated Feed Implementation and Maintenance Plan

## Scope

Certified Feed Service exposes two unauthenticated POST procedures over Magic Indexer's mutable current PostgreSQL state:

```text
app.certified.feed.beta.getFeedSkeleton
app.certified.feed.beta.getFeed
```

The skeleton endpoint returns ordered exact source references. The hydrated endpoint returns validated first-render views and actor summaries. Certified App, Magic Indexer, and AT Protocol repositories are references only; changes remain in this service.

Activity-label hydration, external profile resolution, target previews, caching, blob delivery, and Certified App integration are deferred.

## Architecture

The endpoints share page selection but remain separate public services:

```text
getFeedSkeleton
  -> FeedService
  -> FeedPageLoader.loadPage(metadata)
  -> FeedRepository
  -> one PostgreSQL feed statement, includeSource=false
  -> skeleton projection
  -> generated output validation
```

```text
getFeed
  -> HydratedFeedService
  -> FeedPageLoader.loadPage(with-source)
  -> FeedRepository
  -> one PostgreSQL feed/source statement, includeSource=true
  -> validate selected source records and discover DIDs
  -> IdentityReader.getByDids
  -> validate profiles and sanitize actor fields
  -> build actor summaries and total kind-specific views
  -> generated output validation
```

`HydratedFeedService` coordinates hydration directly. It does not depend on the public skeleton reader, make an internal XRPC call, or introduce a second source query.

## Shared page contract

The internal page boundary is mode-explicit:

```ts
type FeedPageMode = 'metadata' | 'with-source'

interface InternalFeedRow {
  uri: string
  cid: string
  actorDid: string
  collection: string
  kind: FeedKind
  sortValue: string
}

interface InternalSourceFeedRow extends InternalFeedRow {
  sourceValue: unknown
}

interface InternalFeedPage<Row extends InternalFeedRow> {
  rows: readonly Row[]
  cursor?: string
}
```

`FeedPageLoader` owns request normalization, cursor decoding, the repository call and timing, resolved-scope enforcement, `limit + 1` trimming, result metrics, and next-cursor creation. Endpoint services do not duplicate those rules.

Expected query counts:

```text
getFeedSkeleton, any non-error page: 1 feed query
getFeed, non-empty page:            1 feed/source query + 1 identity query
getFeed, empty page:                1 feed query + 0 identity queries
```

No database or network call count may grow with page size.

## Same-statement source selection

`src/feed/feed-query.sql` owns eligibility, classification, project pairing, ordering, keyset pagination, and cursor inputs. Candidate and paged rows remain narrow. After `paged_events` applies ordering and `LIMIT`, source-aware mode joins the final URI/CID rows back to `record` inside the same statement.

```sql
paged_events AS (
  SELECT *
  FROM filtered_events
  ORDER BY effective_at DESC, uri DESC
  LIMIT $12::integer
)
SELECT
  page.uri,
  page.cid,
  page.collection,
  page.actor_did,
  page.kind,
  selected_source.uri,
  selected_source.cid,
  selected_source.collection,
  selected_source.json
FROM scope_meta AS meta
LEFT JOIN paged_events AS page ON true
LEFT JOIN record AS selected_source
  ON $15::boolean
 AND selected_source.uri = page.uri
 AND selected_source.cid = page.cid;
```

Metadata mode binds `includeSource=false` and does not expose a source value to Node. Source-aware mode requires the final URI, CID, and collection to match the selected row. Missing or mismatched join metadata is an internal invariant failure.

Feed selection and source retrieval therefore share one PostgreSQL statement snapshot. Identity retrieval occurs later and intentionally reflects current identity state at that later read.

Source-aware pages count-bound selected rows to `limit + 1` (at most 51), but they do not byte-bound source JSON. Large indexed records can increase PostgreSQL transfer, process memory, validation work, and latency. Source JSON remains internal and is never serialized in the view-only hydrated response. Do not add a byte limit without a separately approved contract and measured production need.

## Ordering, scope, and pairing

Ordering is one coupled contract:

```text
effective timestamp DESC, record URI DESC
```

A valid top-level string `createdAt` is parsed as `timestamptz`; absent, malformed, non-string, or PostgreSQL-invalid values fall back to `record.sort_at`. Keep `pg_input_is_valid` before casting untrusted text.

Cursor v2 is unpadded base64url JSON with exactly:

```ts
{ version: 2, value: string, uri: string }
```

It stores the last emitted timestamp and URI. Timestamp derivation, UTC formatting, descending URI tie-break, trimming point, and cursor bytes must move together. Incompatible changes require a cursor-version bump.

Scope is counted after base authors, evaluator unions, viewer removal, actor membership, and quality policy. A scope over 500 returns its count without expanding project or eligible-event scans and then fails with `FEED_SCOPE_TOO_LARGE`; it is never truncated.

Project/activity pairing happens before kind filtering and pagination. It requires the same author, exact activity URI and CID, and a `sort_at` gap strictly below 60 seconds. The collection becomes `project.created_with_cert`; the paired activity remains suppressed across page boundaries.

## Identity batch and precedence

The identity adapter combines retrieval only:

```ts
interface ActorContext {
  did: string
  actor?: ActorRow
  certifiedProfile?: unknown
}

interface IdentityReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>>
}
```

For non-empty input, one parameterized query starts from deduplicated requested DIDs and left-joins:

- `actor` for only DID, handle, display name, and avatar CID;
- `record` at `at://<did>/app.certified.actor.profile/self` with collection `app.certified.actor.profile`.

Empty input skips PostgreSQL. Every requested DID receives a context even when both joins are absent. The query does not select or recheck `actor.is_active`, select profiles by `record.did`, or require a profile CID. Query rejection fails the request; missing individual rows degrade.

Profile precedence remains pure TypeScript:

```text
valid meaningful Certified profile
  -> preserve an independently valid stored handle
  -> use Certified display name and avatar wholesale
  -> do not backfill blank Certified fields from stored Bluesky fields

missing, invalid, or content-empty Certified profile
  -> use independently sanitized stored handle, display name, and avatar CID

neither available
  -> DID-only summary
```

A Certified profile is meaningful after validation when at least one of display name, description, avatar, banner, pronouns, or website is non-empty. Invalid optional stored actor fields are omitted independently. Public output never exposes which source won.

## Public hydrated model

Hydrated output is view-only:

```ts
type RecordState = 'available' | 'invalid'

interface ActorSummary {
  did: string
  handle?: string
  displayName?: string
  avatar?: ImageReference
}

interface HydratedFeedItemBase {
  id: string
  kind: FeedKind
  subject: FeedSubject
  sortAt: string
  actor: ActorSummary
}

type HydratedFeedItem =
  | (HydratedFeedItemBase & {
      recordState: 'available'
      view: FeedItemView
    })
  | (HydratedFeedItemBase & {
      recordState: 'invalid'
      view?: never
    })
```

The public Lexicon represents `view` as optional because it cannot express the conditional relationship. Internal TypeScript and tests enforce it.

An invalid source retains exact page metadata and the event-author summary but has no view. Source JSON stays internal. `actor.did` already carries the event author, so hydrated items do not duplicate it in another field.

Image variants are explicit `$type` unions:

- URI image: validated URI only;
- blob image: owner DID, CID, and optional MIME/size descriptor;
- no blob bytes, proxy URL invention, or download.

## Source validation and views

Known records validate against `@hypercerts-org/lexicon` exactly `1.0.0`. The trusted database collection and selected feed kind choose the validator; untrusted JSON cannot choose it through its own `$type`.

| Source collection | Feed kind | Public view |
|---|---|---|
| `org.hypercerts.claim.activity` | `cert.create` | `activityView` |
| `org.hypercerts.collection` | `collection.create` | `collectionView` |
| `org.hypercerts.collection` | `project.created_with_cert` | `collectionView` |
| `org.hypercerts.context.evaluation` | `evaluation.create` | `evaluationView` |
| `org.hypercerts.context.measurement` | `measurement.create` | `measurementView` |
| `org.hyperboards.board` | `hyperboard.create` | `hyperboardView` |
| `org.hypercerts.context.attachment` | `update.create` | `updateView` |
| `app.certified.badge.award` | `endorsement.award` | `endorsementView` |

All seven view variants carry full Lexicon `$type` discriminators. Both collection kinds intentionally share one view type while retaining distinct item kinds.

Keep supplemental validation for known blob variants because generated v1.0.0 validation does not enforce every declared MIME, integer-size, nonnegative-size, and maximum-size constraint after `jsonToLex`.

Collection rendering uses required `title`, selects avatar before banner, and ignores legacy name/image fields. Update views choose the first validated `image/*` blob descriptor.

Every validated source produces a view. Endorsement validation discovers an account-subject DID before the identity batch; that DID joins the same batch, and view construction requires its exact summary. Missing actor/profile storage still yields a DID-only endorsement subject. A missing or mismatched discovered summary is an internal invariant error.

## Target links

The service exposes existing strong references without reading their records:

```text
evaluationView.target  = evaluation.subject
measurementView.target = measurement.subjects[0]
updateView.target      = attachment.subjects[0]
```

Each target is the complete `{ uri, cid }` reference accepted by the source record's authoritative validator. Hyperboard omits a target in this version.

Targets do not cause record queries, actor discovery, profile reads, body validation beyond the source validator, previews, or recursive hydration.

## Public Lexicon and HTTP boundary

Committed JSON under `lexicons/` defines the wire contract. Both procedures:

- accept the same request fields and semantic limits;
- use POST and a JSON body;
- expose the same stable public errors;
- enforce the 64 KiB request-body limit and malformed-JSON handling;
- validate generated output inside the expected handler error boundary.

`getFeedSkeleton` remains wire-compatible, including its local typed-definition discriminators. Hydrated image and view unions use explicit `$type` discriminators, and target fields reference `com.atproto.repo.strongRef`.

`@atproto/lex@0.3.0` needs the narrow ignored-output workaround documented in `AGENTS.md`. It changes generated TypeScript inference only; it does not change Lexicon JSON or runtime validation.

Unknown handler, query, validation-invariant, or output-validation failures become redacted `INTERNAL_ERROR` responses. Public errors never expose SQL, credentials, data, causes, or stacks.

## Metrics

Existing bounded HTTP, database, result-size, event-kind, readiness, and error metrics cover both endpoints. Shared page-result metrics count generated page rows even if later hydration fails.

Do not add DIDs, handles, AT-URIs, CIDs, cursors, source values, or other caller/record-controlled labels. Hydration-specific metric families remain deferred until production evidence justifies them.

## TDD and validation

Use small RED → GREEN cycles:

1. Add only enough API or seam scaffolding to compile.
2. Add one focused behavior test.
3. Confirm the intended assertion or explicit not-implemented failure.
4. Implement the smallest passing change.
5. Refactor only while the focused test stays green.
6. Run broader gates and fresh review.

A missing dependency, generated file, fixture, or disposable database is setup failure rather than useful RED evidence. Do not commit intentionally failing tests.

Test ownership:

- page-loader policy: `test/page-loader.unit.test.ts`;
- repository modes and invariants: `test/query.unit.test.ts`;
- PostgreSQL selection/source/pairing/pagination: `test/feed.integration.test.ts`;
- identity retrieval and actor/profile rules: `test/hydration-actors.unit.test.ts`;
- source validation and view mapping: `test/hydration-views.unit.test.ts`;
- hydration coordination and query bounds: `test/hydration-service.unit.test.ts`;
- public JSON and generated parsers: `test/lexicon.unit.test.ts`;
- handlers, body limits, errors, and metrics: `test/app.unit.test.ts`.

Required local gates:

```bash
npm run check
npm test
npm run build
git diff --check
```

Before completion, run integration tests against an explicitly selected empty disposable PostgreSQL 16+ database:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration
```

Before production traffic, collect production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence for:

- maximum-scope metadata mode;
- maximum-scope source-aware mode;
- the combined identity batch.

`ANALYZE` executes the SELECT. Collect this evidence in a controlled production-shaped environment with a read-only role; do not casually run load-bearing cases against a live primary.

Confirm the source JSON join remains after pagination and does not widen candidate sorting. Any required index belongs in Magic Indexer.

## Deferred work

- activity-quality labels, badges, and other label hydration;
- Certified App integration;
- PDS/AppView profile fallback;
- Redis or other cross-request caching;
- historical record recovery or immutable event history;
- blob download, proxying, or CDN resolution;
- target-record hydration, target identity discovery, and target previews;
- recursive/detail hydration;
- contributors, rights, funding, locations, and project-item expansion;
- paired activity body hydration;
- richer measurement, Hyperboard, and project-with-cert cards;
- endorsement graph materialization;
- hydration-specific metrics;
- database migrations and indexes.

## Maintenance acceptance criteria

- Skeleton filtering, classification, pairing, ordering, limits, cursor bytes, and wire shape remain compatible.
- Metadata mode executes one query and exposes no source value.
- Non-empty hydrated pages execute one feed/source statement and one identity query; empty pages skip identity.
- Source JSON comes from the same statement snapshot as page selection and is joined only after pagination.
- Identity retrieval is one complete DID batch and remains a later current-state read.
- Validated sources always produce kind-compatible views; invalid sources keep metadata and author identity without a view.
- Actor precedence, strict v1.0.0 validation, supplemental blob checks, total endorsements, target-link rules, and eight-kind/seven-view mapping remain covered.
- Public hydrated output contains only views, actor summaries, exact source references, state, ordering metadata, and optional cursor.
- No per-item I/O, target read, external profile lookup, cache, migration, write, or unbounded metric label is introduced.
