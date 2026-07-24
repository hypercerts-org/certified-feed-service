# Hydrated Feed Rearchitecture Handoff

## Status and authority

This document is the implementation handoff for reworking the hydrated-feed architecture before the original Milestone 4 begins.

Where this document conflicts with `docs/hydrated-feed-plan.md`, this document is authoritative. Preserve the original plan's behavioral requirements unless they are explicitly replaced below.

Implement changes in **Certified Feed Service only**. Certified App, Magic Indexer, and the local ATProto checkout are read-only references.

## Current repository state

At the time this handoff was written:

```text
branch: hydration/implement-hydrated-feed

commits:
29de300 hydration: add actor and Certified profile readers
5f89314 hydration: add exact record batch reader
e2be499 docs: add hydrated feed implementation plan
```

The working tree also contains uncommitted Milestone 3 work:

```text
M  docs/hydrated-feed-plan.md
M  src/hydration/types.ts
M  src/hydration/validation.ts
M  src/hydration/views.ts
?? test/hydration-views.unit.test.ts
```

Do not reset, discard, overwrite, or accidentally exclude those changes. Inspect the diff before implementation.

Latest local validation before this handoff:

```text
npx vitest run test/hydration-views.unit.test.ts  # 16 passed
npm run check                                     # passed
npm test                                          # 66 passed
npm run build                                     # passed
git diff --check                                  # passed
```

Fresh final reviewers could not run after the last Milestone 3 fix because connectivity failed. Re-review the resulting combined diff after the rearchitecture.

## Final decisions

### Keep separate endpoint services

Preserve modular public services:

```text
FeedSkeletonService
  -> FeedPageLoader.loadPage(metadata)
  -> skeleton projection

HydratedFeedService
  -> FeedPageLoader.loadPage(with-source)
  -> record validation
  -> IdentityReader
  -> actor and view projection
```

`HydratedFeedService` must not call the public `FeedSkeletonReader` abstraction.

### Do not add `FeedHydrator` yet

`HydratedFeedService` owns hydration coordination directly. Keep database access, validation, and projection modular through injected adapters and pure functions:

```text
HydratedFeedService
  -> FeedPageLoader
  -> validateFeedRecord()
  -> IdentityReader
  -> validateCertifiedProfile()
  -> sanitizeActorRow()
  -> buildActorSummary()
  -> buildFeedItemView()
```

Extract a separate coordinator only if later work introduces enough independent policy to justify it.

### Use one statement for page selection and exact source data

The feed query already owns source eligibility, classification, ordering, pagination, and cursor inputs. For hydrated mode, return the selected source JSON from that same PostgreSQL statement and MVCC snapshot.

Do **not** carry potentially large JSON values through candidate sorting. Keep classification and pagination rows narrow, then join the final `limit + 1` URI/CID rows back to `record` inside the same statement.

Conceptual SQL:

```sql
WITH
eligible_records AS (...),
classified_events AS (
  SELECT
    source.uri,
    source.cid,
    source.collection,
    source.did AS actor_did,
    ... AS kind,
    ... AS effective_at
  FROM eligible_records AS source
),
filtered_events AS (...),
paged_events AS (
  SELECT *
  FROM filtered_events
  ORDER BY effective_at DESC, uri DESC
  LIMIT $12::integer
)
SELECT
  meta.scope_count,
  page.uri,
  page.cid,
  page.collection,
  page.actor_did,
  page.kind,
  ... AS sort_value,
  selected_source.uri AS selected_source_uri,
  selected_source.json AS source_json
FROM scope_meta AS meta
LEFT JOIN paged_events AS page ON true
LEFT JOIN record AS selected_source
  ON $15::boolean
 AND selected_source.uri = page.uri
 AND selected_source.cid = page.cid
ORDER BY page.effective_at DESC NULLS LAST, page.uri DESC NULLS LAST;
```

Use a fixed boolean bind such as `includeSource`:

- metadata mode: `false`; do not return source JSON to Node;
- with-source mode: `true`; return collection and exact source JSON.

The exact bind position is implementation-owned, but `src/feed/feed-query.sql` and `src/feed/query.ts` must remain synchronized.

Within hydrated mode, a missing final source join is an internal query invariant failure, not a public `notFound` or `cidMismatch` state. The original page row and final join share one PostgreSQL statement snapshot.

### Combine actor and Certified-profile storage reads

Replace separate actor and profile readers with one parameterized identity batch:

```ts
export interface ActorContext {
  readonly did: string
  readonly actor?: ActorRow
  readonly certifiedProfile?: unknown
}

export interface IdentityReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorContext>>
}
```

Conceptual SQL:

```sql
WITH requested(did) AS (
  SELECT DISTINCT did
  FROM unnest($1::text[]) AS input(did)
)
SELECT
  requested.did,
  actor.handle,
  actor.display_name,
  actor.avatar_cid,
  profile.json AS certified_profile_json
FROM requested
LEFT JOIN actor
  ON actor.did = requested.did
LEFT JOIN record AS profile
  ON profile.uri =
     'at://' || requested.did || '/app.certified.actor.profile/self'
 AND profile.collection = 'app.certified.actor.profile';
```

Requirements:

- deduplicate DIDs;
- empty input performs no query;
- one non-empty batch performs one query;
- return one `ActorContext` for every requested DID, including when both joins are absent;
- do not read or re-check `actor.is_active`;
- select only `actor.did`, `handle`, `display_name`, and `avatar_cid` data;
- match Certified profiles by deterministic URI and collection, not `record.did` or a feed CID;
- keep the raw profile value `unknown` until `validateCertifiedProfile()` succeeds.

The query combines retrieval only. Profile precedence remains pure TypeScript:

```text
valid meaningful Certified profile
  -> Certified display name/avatar wholesale
  -> preserve independently valid stored handle

missing, invalid, or content-empty Certified profile
  -> sanitized stored Bluesky fields

neither available
  -> DID-only summary
```

### Keep exact source and identity query counts bounded

Expected database query counts:

```text
getFeedSkeleton, any non-error page:
  1 feed-page query

getFeed, non-empty page:
  1 feed-page + exact source query statement
  1 combined identity query
  --------------------------------
  2 total queries

getFeed, empty page:
  1 feed-page query
  0 identity queries
```

No query count may grow with page size.

### Public hydrated response is view-only

Drop raw source records and profile provenance from the public response.

```ts
export type RecordState = 'available' | 'invalid'

export interface ActorSummary {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
  readonly avatar?: ImageReference
}

export interface HydratedFeedItemBase {
  readonly id: string
  readonly kind: FeedKind
  readonly subject: FeedSubject
  readonly sortAt: string
  readonly actor: ActorSummary
}

export type HydratedFeedItem =
  | (HydratedFeedItemBase & {
      readonly recordState: 'available'
      readonly view: FeedItemView
    })
  | (HydratedFeedItemBase & {
      readonly recordState: 'invalid'
      readonly view?: never
    })
```

Public Lexicon limitations may require representing `view` as optional plus `recordState` known values. Keep the stronger invariant in internal TypeScript and tests even if the wire schema cannot express the conditional relationship directly.

Do not return:

- raw `record`;
- public `profileSource`;
- source `notFound` or `cidMismatch` states;
- redundant `actorDid` when `actor.did` already carries the resolved event-author DID.

### Include target strong references now

Returning an existing reference is not related-record hydration. Add optional target strong references without fetching or previewing their records:

```text
evaluationView.target  = validated evaluation.subject
measurementView.target = validated measurement.subjects[0]
updateView.target      = validated attachment.subjects[0]
```

Use the complete `{ uri, cid }` strong reference. Keep Hyperboard target omitted for this version.

Still forbidden:

- querying target records;
- target actor/profile discovery;
- target previews;
- recursive hydration;
- target body validation beyond the source record's authoritative validator.

### Make view construction total for valid records

Every `ValidatedFeedRecord` must produce a `FeedItemView`.

For endorsements:

- discover the account-subject DID before the identity batch;
- include it in the combined DID set;
- missing actor/profile rows produce a DID-only `ActorSummary`;
- `buildFeedItemView()` must return an endorsement view for every validated endorsement;
- a missing or mismatched summary after discovery is an actionable internal invariant error, not silent `undefined`.

Invalid source records retain page metadata and an event-author summary but omit `view`.

### Keep `kind` and view `$type`

They serve different contracts:

```text
source record $type -> source AT Protocol record schema
item kind           -> feed-event classification
view $type          -> public Lexicon union variant
```

Examples:

```text
org.hypercerts.collection
  + project.created_with_cert
  -> app.certified.feed.beta.defs#collectionView
```

Both collection feed kinds intentionally share `collectionView`. Add mapping tests so `kind` and view `$type` cannot drift.

### Preserve strict v1.0.0 behavior

Keep `@hypercerts-org/lexicon` exactly pinned to `1.0.0` and the compatible `@atproto/lexicon` parser pin already introduced.

Collection cards use:

```text
required title
avatar -> banner image priority
no legacy name or image fields
```

Keep centralized supplemental MIME, integer-size, nonnegative-size, and maximum-size checks for known blob variants because the generated validator does not enforce all declared constraints after `jsonToLex`.

### Defer hydration-specific metrics

Do not add new hydration duration/state metric families initially. Existing bounded route, database, result, and error metrics are sufficient.

The feed-page query and identity query may use existing fixed database-operation labels. Never introduce DID, URI, CID, cursor, or record values as labels.

## Explicitly superseded design

Remove the original source-refetch pipeline:

```text
FeedSkeletonReader.getFeedSkeleton
  -> ExactRecordReader.getByStrongRefs
  -> notFound/cidMismatch handling
```

It is replaced by:

```text
FeedPageLoader.loadPage(with-source)
  -> one same-snapshot feed statement
  -> post-pagination exact URI/CID join
```

The user explicitly authorized deleting or replacing:

```text
src/hydration/query.ts
test/hydration.unit.test.ts
src/hydration/actors.ts
src/hydration/profiles.ts
```

Also remove:

- exact-reader integration-test blocks from `test/feed.integration.test.ts`;
- exact-reader build-smoke imports;
- obsolete exact-reader types such as `StrongRefKey`, `ExactRecordResult`, and `ExactRecordReader`;
- `notFound` and `cidMismatch` public/domain states;
- separate actor/profile adapter imports and composition.

Replace the actor/profile adapters with a combined identity adapter, preferably `src/hydration/identity.ts`. Existing actor/profile behavior tests may remain in `test/hydration-actors.unit.test.ts` if keeping the file avoids an unnecessary delete; update them to target the combined seam.

Do not rewrite or squash the existing commits unless separately authorized. A later scoped commit may remove code introduced by earlier milestone commits.

## Target call stacks

```text
POST app.certified.feed.beta.getFeedSkeleton
  -> XRPC handler
  -> FeedSkeletonService.getFeedSkeleton
  -> FeedPageLoader.loadPage(metadata)
  -> FeedRepository
  -> PostgreSQL feed statement, includeSource=false
  -> skeleton projection
  -> generated output validation
```

```text
POST app.certified.feed.beta.getFeed
  -> XRPC handler
  -> HydratedFeedService.getFeed
  -> FeedPageLoader.loadPage(with-source)
  -> FeedRepository
  -> PostgreSQL feed statement, includeSource=true
  -> validate source records and discover DIDs
  -> IdentityReader.getByDids
  -> validate profiles and sanitize actor rows
  -> build event-author and endorsement-subject summaries
  -> build total kind-specific views
  -> generated output validation
```

No call stack may contain:

- an internal HTTP/XRPC call to `getFeedSkeleton`;
- `HydratedFeedService -> FeedSkeletonReader`;
- a second source-record query;
- a per-item database or network request;
- Magic Indexer APIs;
- PDS/AppView profile calls;
- blob downloads;
- target-record queries.

## Implementation sequence

### Phase A — Preserve and baseline current work

1. Read `AGENTS.md`, this handoff, the original plan, and the current diff.
2. Read together:
   - `src/feed/feed-query.sql`
   - `src/feed/query.ts`
   - `src/feed/service.ts`
   - `test/feed.integration.test.ts`
   - `docs/database-contract.md`
3. Run:

```bash
npm run check
npm test
npm run build
```

4. Start a fresh disposable PostgreSQL 16 database and run the current integration suite.
5. Treat connectivity or fixture setup failures as setup failures, not TDD RED evidence.

### Phase B — Introduce the internal page loader

Define implementation-shaped internal APIs before changing endpoint behavior:

```ts
export type FeedPageMode = 'metadata' | 'with-source'

export interface InternalFeedRow {
  readonly uri: string
  readonly cid: string
  readonly actorDid: string
  readonly collection: string
  readonly kind: FeedKind
  readonly sortValue: string
}

export interface InternalSourceFeedRow extends InternalFeedRow {
  readonly sourceValue: unknown
}

export interface InternalFeedPage<Row extends InternalFeedRow> {
  readonly rows: readonly Row[]
  readonly cursor?: string
}

export interface FeedPageLoader {
  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>

  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
}
```

The exact placement and naming may follow repository style, but keep the boundary explicit and developer-readable.

Move shared ownership into the loader:

- request normalization;
- cursor decoding;
- repository execution;
- scope-cap enforcement;
- `limit + 1` trimming;
- cursor creation;
- page-result metrics already shared by both endpoints.

The skeleton service projects metadata rows. It must not own a second version of pagination or cursor logic.

### Phase C — Return source JSON in the same statement

Add source-aware result mapping and the post-pagination final join.

Tests must prove:

- metadata mode returns no source body to Node;
- with-source mode returns the exact selected collection and JSON;
- source URI/CID agree with the page row;
- JSON is joined after pagination rather than carried through candidate sorting;
- cursor ordering and bytes remain unchanged;
- project/activity pairing behavior remains unchanged;
- scope-cap behavior remains unchanged;
- one page request invokes the repository once;
- a query invariant failure is explicit and actionable.

After the same-statement path is green, remove the exact reader and its tests/imports.

### Phase D — Replace actor/profile readers with `IdentityReader`

Add the combined adapter and update tests before removing separate adapters.

Tests must prove:

- empty input performs no query;
- duplicates bind once;
- multiple DIDs use one query;
- rows are restored by DID, not storage order;
- every requested DID receives an `ActorContext`;
- missing actor only;
- missing Certified profile only;
- both missing;
- deterministic profile URI and exact collection;
- current profile body is read without a feed CID;
- `actor.is_active` is not selected;
- SQL rejection propagates rather than returning partial context.

Keep all existing validation, sanitization, meaningful-profile, precedence, serialized-blob, and descriptor tests.

### Phase E — Adjust views and response model

Update internal/public types and pure builders:

- drop raw record output;
- drop public `profileSource`;
- drop public `actorDid` if `actor.did` is retained as the event author;
- reduce `RecordState` to `available | invalid`;
- require `view` for available items;
- add target references to evaluation, measurement, and update views;
- make endorsement view construction total;
- preserve all seven view `$type` variants for eight feed kinds;
- retain strict collection rendering and blob checks.

Add tests for:

- valid records always have a view;
- invalid records never have a view;
- invalid records retain page metadata and event-author summary;
- missing identity rows produce DID-only summaries;
- endorsement subjects are included in the one identity batch;
- endorsement view always has the exact subject DID summary;
- evaluation target equals `subject`;
- measurement/update targets use only the first `subjects[]` entry;
- no target reader exists or is called;
- no raw record or `profileSource` appears in output;
- kind/view `$type` mapping is exhaustive.

### Phase F — Public Lexicon and composition

Revise the original Milestones 5–6 around the new model:

- shared skeleton definitions remain wire-compatible;
- hydrated item has view-only output;
- image and view unions retain full `$type` discriminators;
- target uses a strong-reference schema;
- `recordState` contains only `available` and `invalid`;
- no raw `record` field;
- no `profileSource` field;
- input and stable public errors continue matching the skeleton endpoint;
- `getFeed` remains unauthenticated POST;
- generated output fixtures cover every view and target shape;
- handler output validation remains inside the expected error boundary;
- unknown failures remain `INTERNAL_ERROR`.

Production composition should remain constructor-based and explicit. A target shape is:

```ts
const repository = new FeedRepository(database)
const pages = new PostgresFeedPageLoader(
  repository,
  trustedQualityLabelerDids,
  metrics,
)
const identities = new PostgresIdentityReader(database)

const skeleton = new FeedSkeletonService(pages)
const hydrated = new HydratedFeedService(pages, identities)
```

Names may be adjusted to avoid awkward layering, but keep the ownership boundaries and call stacks above.

## Documentation updates

Update in the same implementation milestones:

### `docs/hydrated-feed-plan.md`

- replace the old exact-refetch lifecycle;
- remove `StrongRefKey` and exact-reader seams;
- replace parallel actor/profile reads with one identity batch;
- replace four record states with `available | invalid`;
- remove raw records and their byte-unbounded response rationale;
- remove public `profileSource`;
- add target strong references without target hydration;
- replace `FeedHydrator` coordination with direct hydrated-service coordination;
- defer hydration-specific metrics.

### `docs/database-contract.md`

- document the same-statement post-pagination source join;
- remove the cross-query source-race and exact-reader contract;
- document combined actor/profile identity query;
- retain required actor columns and deterministic profile URI;
- state that feed selection/source retrieval share a statement snapshot while identity is a later current-state read.

### `README.md`

- document both endpoints;
- describe view-only hydrated output;
- explain `available` versus `invalid`;
- explain identity fallback without exposing provenance;
- document target references as links only, not hydrated previews;
- remove raw-record response-size language.

### `AGENTS.md`

- update call stacks, ownership, test seams, and MVP exclusions.

## TDD and review workflow

Use small RED -> GREEN cycles. A setup failure is not a useful RED result.

For each phase:

1. Add only enough scaffolding to compile.
2. Add focused tests for the missing behavior.
3. Confirm the intended assertion or `Not implemented` failure.
4. Implement the smallest passing change.
5. Run focused tests.
6. Run broader gates.
7. Run fresh reviewers for correctness, SQL/snapshot behavior, tests, and simplicity.
8. Apply confirmed fixes through one writer.
9. Repeat review until no blocker or fix worth doing now remains, capped according to the parent orchestration policy.

Keep one writer in the active worktree. Reviewers must be fresh-context and read-only.

## Validation gates

After each implementation phase:

```bash
npm run check
npm test
npm run build
git diff --check
```

Before completion, using an explicitly selected empty disposable PostgreSQL 16 database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/certified_feed_test' \
  npm run test:integration
```

Also verify:

```bash
npm ci
npm ls @hypercerts-org/lexicon @atproto/lexicon --all
```

Stop the disposable database after validation.

Before production use, collect production-shaped:

```sql
EXPLAIN (ANALYZE, BUFFERS)
```

for:

- the maximum-scope metadata page query;
- the maximum-scope with-source page query;
- the combined identity query.

Confirm that source JSON is joined only after pagination and does not widen candidate sorting. Any required index belongs in Magic Indexer.

## Done criteria

- `getFeedSkeleton` remains wire-compatible and independently callable.
- Skeleton filtering, classification, project pairing, ordering, limits, and cursor bytes are unchanged.
- Skeleton requests perform one feed query and do not return source JSON to Node.
- Non-empty hydrated requests perform one feed/source statement plus one identity query.
- Source JSON comes from the same statement snapshot as page selection.
- No `ExactRecordReader`, `StrongRefKey`, source `notFound`, or source `cidMismatch` remains.
- No separate actor/profile storage queries remain.
- Every requested identity DID has an `ActorContext`; missing rows degrade to DID-only.
- Valid records always produce a kind-compatible view.
- Invalid records retain metadata and event-author identity but omit the view.
- Endorsement views are total and use the exact account subject.
- Evaluation, measurement, and update views expose target strong references without target reads.
- Public output contains no raw record, `profileSource`, or redundant `actorDid`.
- All eight feed kinds map to the seven tested Lexicon view variants.
- Strict v1.0.0 validation and supplemental blob constraints remain intact.
- No database/network call count grows with page size.
- No caching, target hydration, external profile lookup, recursive hydration, blob download, migration, or write is introduced.
- Unit, integration, typecheck, build, clean install, generated parser, and production-adapter smoke checks pass.
- Fresh reviewers report no blocker or fix worth doing now.

## Reference implementations

Use these as patterns, not contracts:

- Bluesky keeps explicit skeleton, hydration, rules, and presentation phases while using modular batch hydrators:
  - `~/Projects/atproto/packages/bsky/src/pipeline.ts`
  - `~/Projects/atproto/packages/bsky/src/api/app/bsky/feed/getFeed.ts`
  - `~/Projects/atproto/packages/bsky/src/hydration/hydrator.ts`
  - `~/Projects/atproto/packages/bsky/src/hydration/actor.ts`
- Stratos keeps handler, store, and database modules separate while selecting `recordJson` with the paged post rows:
  - <https://github.com/NorthskySocial/stratos/blob/1a8f42c706ccf17ea52b4c42d6eeca5ee88f89e6/stratos-feedgen/src/api/feed/getFeed.ts#L42-L106>
  - <https://github.com/NorthskySocial/stratos/blob/1a8f42c706ccf17ea52b4c42d6eeca5ee88f89e6/stratos-feedgen/src/db/postgres.ts#L152-L197>

The important distinction is that modular code boundaries do not require repeated database reads of the same source row.
