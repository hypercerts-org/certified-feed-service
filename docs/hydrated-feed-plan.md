# Hydrated Feed Implementation Plan

> **Status and authority:** [`hydrated-feed-rearchitecture-plan.md`](hydrated-feed-rearchitecture-plan.md) supersedes this document's exact source-refetch pipeline, separate actor/profile reads, and old hydration coordinator design. Retain this document only for behavioral requirements that the rearchitecture handoff does not replace; a complete rewrite will follow the implementation.

## Scope

Implement this plan in **Certified Feed Service only**.

Read-only references:

- `~/Projects/gainforest/certified-app` — current feed-card requirements
- `~/Projects/hypercerts/magic-indexer` — PostgreSQL schema and ingestion behavior
- `~/Projects/atproto` — batching and hydration patterns

Do not edit Certified App or Magic Indexer. Certified App integration is a separate follow-up.

Activity-label filtering and annotation are deferred. Existing organization-quality filtering remains unchanged.

Related-record target hydration and target previews are also deferred. Evaluation, measurement, and update items hydrate only their own top-level records in this version.

## TDD workflow

Every behavior follows a small RED → GREEN → REFACTOR cycle:

```text
1. Add only enough API/module scaffolding for the test to compile.
2. Write one focused behavior test.
3. Run it and confirm it fails for the intended missing behavior.
4. Add the smallest implementation that passes.
5. Refactor only while the focused test remains green.
6. Run the broader affected suite before committing.
```

A missing import, failed code generation, broken fixture, or unavailable database is setup failure—not a useful RED result.

Do not commit intentionally failing tests. Record each initial RED command and expected failure in implementation notes or the PR description.

## Goal

Keep the existing skeleton endpoint and add an unauthenticated hydrated endpoint:

```text
POST /xrpc/app.certified.feed.beta.getFeedSkeleton
POST /xrpc/app.certified.feed.beta.getFeed
```

The hydrated endpoint will:

1. Generate one ordered skeleton page.
2. Batch-fetch top-level records directly from the shared PostgreSQL database.
3. Match each source record by exact URI and CID.
4. Validate known records against `@hypercerts-org/lexicon` v1.0.0 as the authoritative schema.
5. Discover every actor and Certified profile needed by the page.
6. Fetch actors and profiles in bounded parallel batches.
7. Build stable, kind-specific feed-card views.
8. Preserve skeleton order and return the skeleton cursor unchanged.

### Request lifecycle

```mermaid
flowchart TD
  request["POST app.certified.feed.beta.getFeed"]
  handler["XRPC handler"]
  service["HydratedFeedService.getFeed"]
  skeleton["Generate one ordered skeleton page"]
  hydrate["Hydrate skeleton items"]
  validate["Validate generated Lexicon output"]
  response["Return items and unchanged cursor"]

  request --> handler --> service --> skeleton --> hydrate --> validate --> response
```

## Active decisions

- Use the service's existing bounded, read-only PostgreSQL pool.
- Do not call Magic Indexer GraphQL/API or import its Go code.
- Magic Indexer remains the database writer and schema owner.
- Treat `@hypercerts-org/lexicon` v1.0.0 as the source of truth for every known Hypercerts record shape.
- Keep `getFeedSkeleton` wire-compatible and independently callable.
- Add `app.certified.feed.beta.getFeed` as an unauthenticated POST procedure.
- Keep the 1–50 page limit; add no separate response-size guard now.
- Do not add Redis, cache interfaces, cache tables, or cross-request caching.
- Do not call PDSs or an AppView for profile fallback inside Feed Service.
- Do not fetch or proxy blob bytes.
- Never substitute a newer record when an exact CID is unavailable.
- Do not hydrate strong references contained inside evaluation, measurement, or update records, and do not return target previews.
- Keep missing, mismatched, or invalid source items as metadata-only feed items.
- Treat an absent or invalid individual row as degradable data, but treat any PostgreSQL query rejection or timeout as a request failure that becomes the existing `INTERNAL_ERROR` response.
- Validate stored actor fields before exposing them; omit invalid optional handle, display-name, or avatar-CID values instead of failing the page.
- Keep raw records count-bounded by the 50-item page limit, but accept and document that they are not byte-bounded in this version.
- Keep cursor creation entirely inside skeleton generation.
- Keep existing organization-quality behavior unchanged.

## Deferred work

- activity-quality label filtering and card badges
- all other label hydration
- Certified App integration
- PDS/AppView profile fallback
- Redis caching
- historical record recovery
- blob proxying or CDN URLs
- related-record target hydration and target previews
- recursive/detail hydration
- contributors, rights, funding, location bodies, or project item expansion
- paired activity hydration for `project.created_with_cert`
- richer measurement, Hyperboard, or project-with-cert cards
- endorsement graph materialization
- database migrations or indexes

## Public response model

Public union variants use Lexicon `$type` discriminators.

```ts
export type RecordState =
  | 'available'
  | 'notFound'
  | 'cidMismatch'
  | 'invalid'

export type ImageReference =
  | {
      readonly $type: 'app.certified.feed.beta.defs#uriImage'
      readonly uri: string
    }
  | {
      readonly $type: 'app.certified.feed.beta.defs#blobImage'
      readonly did: string
      readonly cid: string
      readonly mimeType?: string
      readonly size?: number
    }

export interface ActorSummary {
  readonly did: string
  readonly handle?: string
  readonly displayName?: string
  readonly avatar?: ImageReference
  readonly profileSource: 'certified' | 'bluesky' | 'did'
}

export interface ActivityFeedView {
  readonly $type: 'app.certified.feed.beta.defs#activityView'
  readonly title: string
  readonly shortDescription?: string
  readonly image?: ImageReference
  readonly createdAt?: string
  readonly startDate?: string
  readonly endDate?: string
  readonly locationCount: number
}

export interface CollectionFeedView {
  readonly $type: 'app.certified.feed.beta.defs#collectionView'
  readonly collectionType?: string
  readonly title: string
  readonly shortDescription?: string
  readonly image?: ImageReference
  readonly createdAt?: string
  readonly itemCount: number
}

export interface EndorsementFeedView {
  readonly $type: 'app.certified.feed.beta.defs#endorsementView'
  readonly subject: ActorSummary
  readonly createdAt?: string
}

export interface EvaluationFeedView {
  readonly $type: 'app.certified.feed.beta.defs#evaluationView'
  readonly summary?: string
  readonly createdAt?: string
}

export interface MeasurementFeedView {
  readonly $type: 'app.certified.feed.beta.defs#measurementView'
  readonly metric?: string
  readonly createdAt?: string
}

export interface HyperboardFeedView {
  readonly $type: 'app.certified.feed.beta.defs#hyperboardView'
  readonly createdAt?: string
}

export interface UpdateFeedView {
  readonly $type: 'app.certified.feed.beta.defs#updateView'
  readonly title?: string
  readonly shortDescription?: string
  readonly image?: ImageReference
  readonly createdAt?: string
}

export type FeedItemView =
  | ActivityFeedView
  | CollectionFeedView
  | EndorsementFeedView
  | EvaluationFeedView
  | MeasurementFeedView
  | HyperboardFeedView
  | UpdateFeedView

export interface HydratedFeedItem {
  readonly id: string
  readonly kind: FeedKind
  readonly subject: FeedSubject
  readonly actorDid: string
  readonly sortAt: string
  readonly recordState: RecordState
  readonly record?: unknown
  readonly actor: ActorSummary
  readonly view?: FeedItemView
}

export interface GetHydratedFeedOutput {
  readonly items: readonly HydratedFeedItem[]
  readonly cursor?: string
}
```

`record` is the validated indexed JSON representation for the exact source CID. It supports forward compatibility, but normal feed-card rendering should use `view`.

The 50-item page limit bounds the number of raw records, not their byte size. Unusually large indexed records can therefore increase database transfer, process memory, serialization time, latency, and response size. This is an accepted initial risk; add a byte budget only after production measurements justify one.

A metadata-only item still contains its skeleton fields and actor summary. It omits both `record` and `view` because the exact source was missing, mismatched, or invalid.

## Internal seams

Use one canonical key for every exact strong reference:

```ts
export type StrongRefKey = string

export const strongRefKey = (subject: FeedSubject): StrongRefKey =>
  `${subject.uri}\u0000${subject.cid}`
```

AT-URIs and CIDs cannot contain NUL, so the encoding is unambiguous.

```ts
export type ExactRecordResult =
  | {
      readonly state: 'available'
      readonly subject: FeedSubject
      readonly collection: string
      readonly did: string
      readonly value: unknown
    }
  | { readonly state: 'notFound'; readonly subject: FeedSubject }
  | { readonly state: 'cidMismatch'; readonly subject: FeedSubject }

export interface ExactRecordReader {
  getByStrongRefs(
    subjects: readonly FeedSubject[],
  ): Promise<ReadonlyMap<StrongRefKey, ExactRecordResult>>
}

export interface ActorReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, ActorRow>>
}

export interface IndexedCertifiedProfile {
  readonly did: string
  readonly value: unknown
}

export interface CertifiedProfileReader {
  getByDids(
    dids: readonly string[],
  ): Promise<ReadonlyMap<string, IndexedCertifiedProfile>>
}

export interface FeedItemHydrator {
  hydrate(
    items: readonly FeedSkeletonItem[],
  ): Promise<readonly HydratedFeedItem[]>
}

export interface HydratedFeedReader {
  getFeed(input: GetFeedSkeletonInput): Promise<GetHydratedFeedOutput>
}
```

## Target call stack

```text
POST app.certified.feed.beta.getFeed
  -> XRPC handler
  -> HydratedFeedService.getFeed
  -> existing FeedSkeletonReader.getFeedSkeleton
  -> existing FeedService
  -> existing FeedRepository
  -> PostgreSQL skeleton query
  -> FeedHydrator.hydrate
  -> ExactRecordReader: top-level URI+CID batch
  -> validate available source records and discover actor DIDs
  -> Promise.all
       -> ActorReader: event authors + endorsed subjects
       -> CertifiedProfileReader: raw deterministic self records
  -> validate Certified profiles and stored actor fields
  -> pure actor and view builders
  -> generated Lexicon output validation
  -> response with original skeleton cursor
```

### Hydration batch pipeline

```mermaid
flowchart TD
  skeleton["Ordered skeleton page"]
  topLevel["Batch 1: fetch exact top-level records"]
  discover["Validate records and discover actor DIDs"]

  subgraph parallel["Batch 2: bounded reads run in parallel"]
    direction LR
    actors["Actors"]
    profiles["Certified profiles"]
  end

  build["Build actor summaries and kind-specific views"]
  restore["Restore original skeleton positions and order"]

  skeleton --> topLevel --> discover
  discover --> actors
  discover --> profiles
  actors --> build
  profiles --> build
  build --> restore
```

No call stack may contain:

- Magic Indexer GraphQL/API;
- an internal HTTP call to `getFeedSkeleton`;
- a per-item database or network request;
- a PDS/AppView profile request;
- a blob download.

## Milestone 0 — Baseline and test scaffolding

Before changing behavior:

```bash
npm run check
npm test
npm run build
```

Start the disposable PostgreSQL container described below and verify the current integration suite is green.

For each later milestone:

- add interfaces or a stub that throws `Not implemented` so tests compile;
- run codegen before tests that import generated Lexicon output;
- install/pin required dependencies before validator behavior tests;
- treat a setup failure as setup work, not RED.

## Milestone 1 — Exact record batch reader

### RED

Add tests for:

- exact URI+CID returning `record.json`;
- missing URI returning `notFound`;
- existing URI with another CID returning `cidMismatch` without exposing its body;
- duplicate exact references being bound once;
- the same URI requested with two different CIDs remaining two distinct map keys;
- crossed URI/CID pairs never returning a body;
- empty input avoiding PostgreSQL.

Required fixtures:

```text
Stored:
  URI-A + CID-A
  URI-B + CID-B

Requested:
  URI-A + CID-B
  URI-B + CID-A

Expected:
  both cidMismatch
  no record body returned
```

Also request `URI-A + CID-A` and `URI-A + CID-B` together to prove map keys include both URI and CID.

Run the focused unit and integration tests and confirm expected assertion/`Not implemented` failures.

### GREEN

Deduplicate exact URI+CID pairs before binding. Use zipped arrays and one left join:

```sql
WITH requested(uri, cid) AS (
  SELECT DISTINCT uri, cid
  FROM unnest($1::text[], $2::text[]) AS input(uri, cid)
)
SELECT
  requested.uri AS requested_uri,
  requested.cid AS requested_cid,
  source.cid AS current_cid,
  source.did,
  source.collection,
  CASE
    WHEN source.cid = requested.cid THEN source.json
    ELSE NULL
  END AS source_json
FROM requested
LEFT JOIN record AS source
  ON source.uri = requested.uri
```

Return `source.json` only when `current_cid = requested_cid`.

Do not use independent `uri = ANY(...) AND cid = ANY(...)` predicates.

The SQL remains a small inline constant in `src/hydration/query.ts`; no new SQL-copy build asset is introduced.

### Exact strong-reference resolution

```mermaid
flowchart TD
  input["Requested URI and CID"]
  key["Deduplicate by the combined URI + CID key"]
  lookup["Look up the current row by URI"]
  exists{"Does the URI exist?"}
  matches{"Does the current CID exactly match?"}
  missing["notFound — return no record body"]
  mismatch["cidMismatch — return no record body"]
  available["available — return current record.json"]

  input --> key --> lookup --> exists
  exists -- "No" --> missing
  exists -- "Yes" --> matches
  matches -- "No" --> mismatch
  matches -- "Yes" --> available
```

### Files

```text
src/hydration/types.ts
src/hydration/query.ts
test/hydration.unit.test.ts
test/feed.integration.test.ts
scripts/check-build.mjs
```

Update the build smoke script to import the production hydration query adapter without starting the server.

## Milestone 2 — Actor and Certified profile readers

Only fetch fields used by feed-card actor summaries:

```text
actor.did
actor.handle
actor.display_name
actor.avatar_cid
```

Do not require `banner_cid`, `description`, `pds`, or other unused actor columns. The existing migration-041 compatibility floor already includes the required fields, so no Magic schema-version bump is needed.

Do not fetch or re-check `actor.is_active` during hydration. The skeleton query's `active_scope` CTE owns actor-liveness filtering. If an actor becomes inactive after skeleton generation, preserve the selected item and cursor; a later skeleton request will exclude that actor.

### Setup

Pin `@hypercerts-org/lexicon` exactly at `1.0.0` in `package.json` and `package-lock.json`. Add a compiling pure Certified-profile validator stub before writing profile behavior tests.

Update the disposable `actor` fixture with `handle`, `display_name`, and `avatar_cid`, then recreate the PostgreSQL container before the first Milestone 2 RED run. `CREATE TABLE IF NOT EXISTS` does not add columns to the table created during baseline validation, so reusing that table would be setup failure rather than a useful RED result.

### RED

Add tests for:

- one actor batch for multiple DIDs;
- missing actor rows;
- deterministic Certified profile lookup at `at://<did>/app.certified.actor.profile/self`;
- current Certified profile records being read by URI, not by a stale feed CID;
- empty batches avoiding PostgreSQL;
- malformed, wrong-type, or invalid-image Certified profiles falling back to stored Bluesky actor fields;
- profile validation using the pinned v1.0.0 schema before any field reaches `ActorSummary`;
- malformed or oversized stored handles and display names being omitted independently;
- invalid stored avatar CIDs being omitted without failing the page or discarding other valid actor fields.

Define a meaningful Certified profile exactly as Certified App does, but only after the record validates. It is meaningful when at least one of these is non-empty:

```text
displayName
description
avatar
banner
pronouns
website
```

Add website-only and description-only tests even though `ActorSummary` currently projects only display name and avatar.

Profile precedence tests:

```text
valid, meaningful Certified profile
  -> preserve the independently stored valid handle
  -> use Certified display name and avatar wholesale
  -> do not fill blank Certified profile fields from Bluesky

missing, invalid, or content-empty Certified profile
  -> use validated stored Bluesky handle, display name, and avatar CID

neither available
  -> DID-only summary
```

This matches Certified App's current all-or-nothing profile precedence. A website-only, description-only, banner-only, or pronouns-only Certified profile is meaningful: `profileSource` is `certified`, the valid stored handle remains available, and stored Bluesky display-name and avatar fields are not backfilled. Never cast raw profile JSON directly to a validated profile type.

### Actor-summary precedence

```mermaid
flowchart TD
  did["Actor DID"]
  certified["Read deterministic Certified profile"]
  valid{"Does it validate against v1.0.0?"}
  meaningful{"Is the Certified profile meaningful?"}
  useCertified["Preserve handle; use Certified profile fields wholesale"]
  bluesky{"Are valid stored Bluesky actor fields available?"}
  useBluesky["Use validated stored Bluesky fields"]
  didOnly["Use a DID-only summary"]
  summary["ActorSummary"]

  did --> certified --> valid
  valid -- "Yes" --> meaningful
  valid -- "No" --> bluesky
  meaningful -- "Yes" --> useCertified --> summary
  meaningful -- "No" --> bluesky
  bluesky -- "Yes" --> useBluesky --> summary
  bluesky -- "No" --> didOnly --> summary
```

### GREEN

Add parameterized actor and profile readers, a pure `validateCertifiedProfile()` function, a pure stored-actor sanitizer, and a pure `buildActorSummary()` function. The profile reader returns raw JSON through `IndexedCertifiedProfile`; only the validator can produce the typed value consumed by precedence logic. The actor sanitizer validates each optional stored field independently and omits invalid values; it never changes the requested DID or turns one malformed optional field into a page failure.

### Files

```text
package.json
package-lock.json
src/hydration/actors.ts
src/hydration/profiles.ts
src/hydration/validation.ts
src/hydration/views.ts
test/hydration-actors.unit.test.ts
test/feed.integration.test.ts
docs/database-contract.md
scripts/check-build.mjs
```

Update the database contract with only the actor columns actually required.

## Milestone 3 — Record validation and pure view builders

### Setup

Reuse the exact `@hypercerts-org/lexicon` v1.0.0 dependency pinned in Milestone 2. Add compiling top-level-record validator and view-builder stubs before the first behavior test. A missing dependency or module is not the RED result.

Keep dependency-specific validation behind one pure adapter. The trusted `record.collection` column chooses the validator; never choose a validator from the untrusted JSON body's `$type`.

| Source collection | Allowed feed kinds | v1.0.0 validator |
|---|---|---|
| `org.hypercerts.claim.activity` | `cert.create` | `OrgHypercertsClaimActivity.validateRecord` |
| `org.hypercerts.collection` | `collection.create`, `project.created_with_cert` | `OrgHypercertsCollection.validateRecord` |
| `org.hypercerts.context.evaluation` | `evaluation.create` | `OrgHypercertsContextEvaluation.validateRecord` |
| `org.hypercerts.context.measurement` | `measurement.create` | `OrgHypercertsContextMeasurement.validateRecord` |
| `org.hyperboards.board` | `hyperboard.create` | `OrgHyperboardsBoard.validateRecord` |
| `org.hypercerts.context.attachment` | `update.create` | `OrgHypercertsContextAttachment.validateRecord` |
| `app.certified.badge.award` | `endorsement.award` | `AppCertifiedBadgeAward.validateRecord` |

Collection records use their own exported validator and may map to either collection feed kind. Treat the source as invalid when its trusted database collection is not allowed for the skeleton kind, its `$type` is missing or wrong, or the selected validator fails. Add an import smoke test for every listed export before validator behavior tests.

### RED

Add fixture-based tests for valid and invalid records plus every view variant.

Required first-render fields:

| Kind | View fields |
|---|---|
| `cert.create` | title, short description, image descriptor, authored timestamp, start/end dates, location count |
| `collection.create` | collection type, required title, short description, image descriptor from avatar then banner, authored timestamp, item count |
| `project.created_with_cert` | same collection view; distinct item kind remains |
| `endorsement.award` | endorsed actor summary and authored timestamp |
| `evaluation.create` | summary and authored timestamp |
| `measurement.create` | metric and authored timestamp |
| `hyperboard.create` | authored timestamp and verb-only view |
| `update.create` | title, short description, authored timestamp, and first `image/*` blob descriptor |

Collection views follow the strict v1.0.0 schema: use the required `title`, select `avatar` before `banner`, and do not read legacy `name` or `image` fields.

Test that:

- invalid top-level records become `recordState: 'invalid'`;
- unavailable exact records keep skeleton metadata;
- database collection, skeleton kind, and record `$type` disagreements become `recordState: 'invalid'`;
- evaluation, measurement, and update views contain no target preview and cause no related-record read;
- raw records are supporting data while cards can render from `view`;
- the update builder selects the first blob whose MIME type starts with `image/` and ignores PDFs, other non-image blobs, and arbitrary URI content;
- blob values become descriptors rather than URLs or bytes;
- each public union object contains its full Lexicon `$type`;
- no view builder performs I/O.

### GREEN

Add pure validators and view builders. Do not place database, logging, metrics, or HTTP dependencies in these modules.

### Files

```text
src/hydration/validation.ts
src/hydration/views.ts
test/hydration-views.unit.test.ts
```

## Milestone 4 — Hydration coordinator

### RED

Use deliberately shuffled fake reader results to test that the coordinator—not the storage reader—restores skeleton order.

Add tests proving:

- skeleton generation runs once;
- top-level exact records are fetched once;
- actor and profile DIDs are deduplicated across the whole page;
- actors include event authors and endorsed subjects;
- actor and profile batches run in parallel after source discovery;
- no related-record batch occurs for evaluation, measurement, or update records;
- duplicate skeleton positions remain duplicated;
- missing/mismatched/invalid source records produce metadata-only items;
- the cursor is copied byte-for-byte;
- an empty page performs no hydration reads;
- no actor-liveness re-filtering, backfilling, or recursive hydration occurs;
- any rejection from the top-level record, actor, or profile reader fails the hydrated request and reaches the existing unknown-error/`INTERNAL_ERROR` path rather than silently returning partial database results.

Add a deterministic PostgreSQL mutation-race integration test. Wrap the real `FeedSkeletonReader` in a test-only decorator that captures its real skeleton page, replaces or deletes one selected source row through the test setup connection, and only then returns the captured page to `HydratedFeedService`. Use the real hydrator and exact-record reader after that barrier. Prove that hydration never returns a newer body, preserves skeleton order, and copies the captured cursor unchanged. Do not add a production race-test hook.

Add metrics assertions here, where metrics are introduced. Inject recognizable DID, URI, CID, cursor, and record strings, then verify none appear as Prometheus label values. Existing result-item and result-kind metrics count skeleton pages generated internally for either endpoint, even if later hydration fails; update their help text to describe generation rather than successful public skeleton responses. Hydration outcome metrics remain separate.

### GREEN

Implement:

```ts
HydratedFeedService.getFeed(input)
  -> skeletons.getFeedSkeleton(input)
  -> exactRecords.getByStrongRefs(topLevelSubjects)
  -> validate top-level records and discover actor DIDs
  -> Promise.all([
       actors.getByDids(allActorDids),
       profiles.getByDids(allActorDids),
     ])
  -> validate Certified profiles and stored actor fields
  -> buildActorSummary()
  -> buildFeedItemView()
  -> return original cursor
```

Add bounded hydration duration and result-state metrics. Keep existing item and kind metrics as skeleton-generation metrics for calls originating from either endpoint, and update their help text accordingly. Never label metrics with caller- or record-controlled identifiers.

### Per-item degradation

```mermaid
flowchart TD
  skeleton["Skeleton item"]
  source{"Exact source-record state"}
  validate{"Does the available record validate?"}
  metadataMissing["Metadata-only item<br/>notFound or cidMismatch"]
  metadataInvalid["Metadata-only item<br/>invalid"]
  actors["Resolve validated actor summary"]
  view["Build the kind-specific view"]
  position["Return item in its original skeleton position"]

  skeleton --> source
  source -- "notFound or cidMismatch" --> metadataMissing --> position
  source -- "available" --> validate
  validate -- "No" --> metadataInvalid --> position
  validate -- "Yes" --> actors --> view --> position
```

### Files

```text
src/hydration/service.ts
src/metrics.ts
test/hydration-service.unit.test.ts
```

## Milestone 5 — Public Lexicon contract

Complete this as its own TDD cycle before handler registration.

### RED

Add a contract test that expects:

- `app.certified.feed.beta.getFeed`;
- input fields, limits, defaults, and semantics matching `getFeedSkeleton`;
- the same public error names as `getFeedSkeleton`;
- shared organization-quality and skeleton-item definitions referenced by both procedures;
- explicit `$type`-based image variants;
- explicit `$type`-based feed-view variants for the seven view shapes used by the eight feed kinds;
- no related-target preview definition or target field;
- `recordState` known values;
- optional raw `record` as Lexicon `unknown`;
- optional cursor unchanged from the skeleton contract;
- generated `$output.schema.$parse()` acceptance fixtures for both image variants and every feed-view variant, including both feed kinds that use `collectionView`;
- generated parser rejection fixtures for missing or unknown `$type` discriminators and malformed DID, CID, URI, or negative-size image descriptors.

Run the contract test and confirm it fails because the schema is absent.

### GREEN

Add:

```text
lexicons/app/certified/feed/beta/defs.json
lexicons/app/certified/feed/beta/getFeed.json
```

Move the organization-quality policy and skeleton-item schemas into `defs.json`, then make both procedures reference those definitions. Define `getFeed` with the same input fields and public errors as `getFeedSkeleton`. Keep contract tests that compare both procedures and prove the existing skeleton wire request and response remain unchanged.

Constrain image descriptors in the public Lexicon: `did` uses `format: "did"`, `cid` uses `format: "cid"`, `uri` uses `format: "uri"`, and `size` is an integer with a minimum of zero. Keep `mimeType` and `size` optional because stored actor avatars provide only a CID.

Run codegen and make the structural contract tests and generated response-parser fixtures green before writing handler tests. These tests validate sample public responses only; they do not add runtime hydration behavior.

### Files

```text
lexicons/app/certified/feed/beta/defs.json
lexicons/app/certified/feed/beta/getFeed.json
lexicons/app/certified/feed/beta/getFeedSkeleton.json
test/lexicon.unit.test.ts
```

Generated `src/lexicons/` remains ignored and must not be committed.

## Milestone 6 — Public handler and composition

### RED

With generated Lexicon output available, add HTTP tests for:

- unauthenticated successful POST;
- POST-only enforcement;
- 64 KiB request-size protection;
- malformed JSON;
- existing feed input validation;
- generated output validation;
- expected `FeedError` translation;
- unknown failures becoming `INTERNAL_ERROR`;
- bounded `feed_hydrated` route metrics;
- existing `getFeedSkeleton` behavior remaining unchanged;
- hydrated-endpoint validation errors naming `app.certified.feed.beta.getFeed`, not `getFeedSkeleton`.

Before handler registration, the focused route test should fail with the expected 404/unregistered-method behavior—not a codegen or import error.

### GREEN

Add `src/api/get-feed.ts`, register the method, and replace the single hard-coded XRPC path with fixed route metadata containing each path, NSID, and bounded metric label.

Make Lexicon validation-error normalization accept the routed NSID.

Production composition remains constructor-based:

```ts
const database = new Database(config, logger)

const skeletonService = new FeedService(
  new FeedRepository(database),
  config.trustedQualityLabelerDids,
  metrics,
)

const exactRecords = new PostgresExactRecordReader(database)
const actors = new PostgresActorReader(database)
const profiles = new PostgresCertifiedProfileReader(database)

const hydrator = new FeedHydrator(
  exactRecords,
  actors,
  profiles,
  metrics,
)

const hydratedFeed = new HydratedFeedService(
  skeletonService,
  hydrator,
)

const app = createApp(
  database,
  { skeleton: skeletonService, hydrated: hydratedFeed },
  metrics,
  logger,
)
```

### Files

```text
src/api/get-feed.ts
src/app.ts
src/server.ts
src/metrics.ts
test/app.unit.test.ts
scripts/check-build.mjs
README.md
docs/database-contract.md
AGENTS.md
```

The build smoke script must import every production hydration adapter without starting the server. Hydration SQL remains inline, so `scripts/copy-sql.mjs` stays focused on the canonical feed SQL.

## Disposable PostgreSQL environment

Start PostgreSQL 16 before the first SQL RED step:

```bash
docker run --rm -d \
  --name certified-feed-test-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=certified_feed_test \
  -p 127.0.0.1:55432:5432 \
  postgres:16
```

Wait until PostgreSQL reports ready, then use:

```bash
export TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/certified_feed_test'
```

Run SQL RED and GREEN tests with:

```bash
npm run codegen
TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  npx vitest run test/feed.integration.test.ts
```

Run the complete integration suite with:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:integration
```

Stop and remove the disposable database after validation:

```bash
docker stop certified-feed-test-postgres
```

Never target a shared, staging, or production database.

## Documentation updates

Update in the same milestone that changes behavior:

- `README.md`
  - document both endpoints;
  - remove the statement that the service never hydrates;
  - explain record states, profile fallback, views, and blob descriptors;
  - state that raw records are count-bounded but not byte-bounded;
  - retain exclusions for caching, labels, detail hydration, and blob bytes.
- `docs/database-contract.md`
  - document exact top-level record, actor, and Certified profile reads;
  - document current-state races and CID mismatch behavior;
  - document that hydration queries are separate current-state reads rather than one page-wide snapshot;
  - document the actor columns now required;
  - document that raw record bodies are count-bounded but not byte-bounded and may increase memory, latency, and response size.
- `AGENTS.md`
  - update call stacks, owning layers, tests, and MVP boundaries.

No new environment variables are required. Existing `TRUSTED_QUALITY_LABELER_DIDS` remains organization-only.

## Validation gates

After each focused GREEN cycle:

```bash
npm run check
npm test
npm run build
```

Before completion:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:integration
```

Before production use, run representative:

```sql
EXPLAIN (ANALYZE, BUFFERS)
```

for:

- the existing maximum-size skeleton query;
- top-level exact record batches;
- actor batches;
- Certified profile batches.

Any required index change belongs in Magic Indexer and is outside this repository.

## Acceptance criteria

- Existing skeleton output, filtering, ordering, and cursor behavior remain unchanged.
- Exact source hydration never substitutes a newer CID.
- Strong-reference maps and deduplication use URI and CID together.
- All eight feed kinds map to seven tested first-render view variants; both collection kinds use `collectionView`.
- Every public union variant uses a valid Lexicon `$type`, and generated response-parser fixtures cover every variant.
- Known records are validated against the trusted database collection's `@hypercerts-org/lexicon` v1.0.0 validator; collection, kind, and `$type` disagreements degrade to `invalid`.
- Evaluation, measurement, and update views omit target previews and perform no related-record hydration.
- Actor summaries follow valid, meaningful Certified profile → validated stored Bluesky fields → DID fallback while preserving a valid stored handle independently.
- Invalid Certified profiles never reach public summaries and fall back deterministically.
- Invalid optional stored actor fields are omitted independently instead of failing the page.
- Actor liveness is filtered only during skeleton scope resolution; hydration never drops or reorders selected items.
- No query count grows linearly with page size.
- Missing, mismatched, or invalid individual data degrades without failing or reordering the page; PostgreSQL query failures fail the request through the existing `INTERNAL_ERROR` path.
- Source-record mutation races never substitute a newer body.
- Raw record bodies are count-bounded but not byte-bounded, and that accepted initial operational risk is documented.
- `getFeed` matches the skeleton input and error contract, is unauthenticated, Lexicon-defined, and limited to 50 items.
- Cursor payload and ordering remain unchanged.
- No caching, label hydration, Magic API calls, PDS profile calls, blob downloads, migrations, writes, or Certified App changes are introduced.
- Unit, integration, typecheck, build, and production-adapter smoke checks pass.
- The disposable PostgreSQL container is stopped after testing.

## Suggested scoped commits

Create commits only after each milestone is GREEN. Include behavior documentation in the milestone that changes that behavior rather than deferring it to a later docs-only stage:

```text
hydration: add exact record batch reader
hydration: add actor and Certified profile readers
hydration: build kind-specific feed views
hydration: compose hydrated feed pages
lexicons: define hydrated feed contract
api: expose and document hydrated feed procedure
```
