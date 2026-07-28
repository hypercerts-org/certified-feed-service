# Certified Feed Service

Standalone, read-only TypeScript service that reads Hyperindex's current PostgreSQL state and serves ordered Hypercerts feeds over XRPC.

> **Pre-release:** This service and its Lexicons have not had their first public release. Wire contracts may change without backward compatibility.

Hyperindex is the only supported database owner. The service exposes an exact-reference skeleton and a view-only hydrated feed; it does not ingest or mutate indexed data, import Hyperindex code, call its GraphQL API, authenticate callers, fetch blob bytes, or provide immutable event history.

## Endpoints

Both endpoints are unauthenticated POST procedures with the same request fields, limits, cursor contract, and stable public errors. The request's `viewerDid` selects the viewer scope and is not verified against an authenticated caller:

```text
POST /xrpc/app.certified.feed.beta.getFeedSkeleton
POST /xrpc/app.certified.feed.beta.getFeed
Content-Type: application/json
```

They are app-specific XRPC procedures, not Bluesky's `app.bsky.feed.getFeedSkeleton` query.

### Request

```bash
curl -sS http://localhost:3000/xrpc/app.certified.feed.beta.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "viewerDid": "did:plc:ar7c4by46qjdydhdevvrndac",
    "trustedEvaluators": ["did:plc:ewvi7nxzyoun6zhxrhs64oiz"],
    "organizationQuality": {
      "allowed": ["high-quality", "standard"],
      "includeUnrated": false
    },
    "limit": 20
  }'
```

Use the same body with `getFeedSkeleton` when a downstream data plane only needs exact source references.

### Skeleton response

```json
{
  "items": [
    {
      "id": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.claim.activity/3kpn",
      "kind": "cert.create",
      "subject": {
        "uri": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.claim.activity/3kpn",
        "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u"
      },
      "actorDid": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
      "sortAt": "2026-07-21T10:00:00.000000Z"
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjoxLCJ2YWx1ZSI6IjIwMjYtMDctMjFUMTA6MDA6MDAuMDAwMDAwWiIsInVyaSI6ImF0Oi8vZGlkOnBsYzpld3ZpN254enlvdW42emh4cmhzNjRvaXovb3JnLmh5cGVyY2VydHMuY2xhaW0uYWN0aXZpdHkvM2twbiJ9"
}
```

### Hydrated response

```json
{
  "items": [
    {
      "id": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.context.evaluation/3kpn",
      "kind": "evaluation.create",
      "subject": {
        "uri": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.context.evaluation/3kpn",
        "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u"
      },
      "sortAt": "2026-07-21T10:00:00.000000Z",
      "actor": {
        "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
        "handle": "evaluator.example",
        "displayName": "Evaluator"
      },
      "view": {
        "$type": "app.certified.feed.beta.defs#evaluationView",
        "summary": "Strong evidence",
        "createdAt": "2026-07-21T10:00:00.000Z",
        "target": {
          "uri": "at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/target",
          "cid": "bafyreifxcn6ts5hr6oequ5w5jyrpwrdl6p5lq46jasnxmcw3h3sme6asru"
        }
      }
    }
  ]
}
```

Hydrated items are view-only:

- Every returned item has a validated source record and a required kind-specific `view`.
- Selected source records that fail validation are omitted. The service does not refill the page, so a hydrated page may contain fewer than `limit` items, or no items, while still returning a cursor that advances over the selected source page.
- The nested feed-view union is open. Clients must tolerate view `$type` values they do not recognize.
- The response does not expose source JSON or identity provenance.
- Actor summaries use a valid meaningful Certified profile first, then the current validated `app.bsky.actor.profile`, then a validated stored Hyperindex handle, then the DID alone. A valid stored handle is preserved independently. Bluesky profile blobs come from the deterministic indexed profile record; the service does not call a PDS or AppView.
- Evaluation, measurement, and update views may include an exact `{ uri, cid }` target. The source record's authoritative validator validates the strong-reference shape. The service does not query, preview, recursively hydrate, or validate the referenced target record or body.
- Image values use open unions so clients can tolerate future variants. Known values preserve protocol-native `org.hypercerts.defs#uri`, `#smallImage`, `#largeImage`, or `#smallBlob` wrappers and their nested AT Protocol blob refs. The containing actor supplies the repository DID; the service never fetches or proxies bytes.

## Request flow

```mermaid
sequenceDiagram
    actor Client
    participant HTTP as HTTP App
    participant XRPC as XRPC Handler
    participant Service as FeedService / HydratedFeedService
    participant Loader as Feed Page Loader
    participant Repo as Feed Repository
    participant Identity as Identity Reader
    participant DB as Hyperindex PostgreSQL

    Client->>HTTP: POST feed procedure
    HTTP->>XRPC: Bounded, validated JSON
    XRPC->>Service: Endpoint input
    Service->>Loader: Load metadata or source-aware page
    Loader->>Repo: One normalized feed query
    Repo->>DB: Hyperindex selection statement
    DB-->>Repo: Scope and limit+1 rows
    Repo-->>Loader: Metadata or exact selected sources
    Loader-->>Service: Selected page and cursor
    alt Hydrated endpoint
        Service->>Service: Validate sources and omit invalid rows
        Service->>Identity: Requested actor DIDs when needed
        Identity->>DB: One actor/profile batch
        DB-->>Identity: Current identity contexts
        Identity-->>Service: Complete DID map
        Service-->>XRPC: View-only items and selected-page cursor
    else Skeleton endpoint
        Service-->>XRPC: Exact references and cursor
    end
    XRPC-->>HTTP: Procedure response
    HTTP-->>Client: JSON response
```

## Request behavior

- Malformed JSON or an invalid `viewerDid` returns HTTP 400 with `InvalidRequest`; it never becomes an internal server error.
- The base scope always comes from the viewer's current `app.certified.graph.follow` records; malformed follow subjects are ignored.
- `trustedEvaluators` adds subjects of each evaluator's current active endorsement awards.
- Endorsement definitions without `allowedIssuers` permit any issuer. When present, only listed issuer DIDs qualify; an empty or malformed value permits none.
- The viewer is removed. Hyperindex purges source records for explicitly deleted, deactivated, suspended, or taken-down identities, so feed selection does not query actor status.
- Organization-quality policy runs against the final author union before selecting events. Organizations are detected only by exact `app.certified.actor.organization/self` records.
- Trusted quality labelers come only from service configuration. Quality labels are bare-DID, non-CID `external_label` rows; callers cannot choose label sources.
- Omitted or empty `kinds` includes all supported kinds. Unknown kinds are rejected.

Supported event kinds:

```text
cert.create
collection.create
project.created_with_cert
evaluation.create
measurement.create
hyperboard.create
update.create
endorsement.award
```

Project and activity records fold before kind filtering and pagination. A paired activity cannot leak onto a later page after its collection is returned as `project.created_with_cert`.

## Ordering and current-state behavior

Ordering is:

```text
effective timestamp DESC, record URI DESC
```

The effective timestamp is `COALESCE(record.record_created_at, record.indexed_at)`. Hyperindex materializes a valid top-level `json.createdAt` into `record_created_at`; `indexed_at` is the fallback. The query fetches `limit + 1` events to decide whether to return a next cursor.

The opaque cursor stores the timestamp and URI of the last selected source row before hydration. Both endpoints use the same page loader, so ordering and cursor bytes are identical for the same request. Hydration may omit invalid selected sources without changing cursor advancement. Cursor traversal is deterministic for each query but does not provide snapshot isolation across requests.

For a skeleton request, the service performs one feed query. A hydrated page with at least one validated source performs one feed/source statement plus one identity batch. An empty or entirely invalid selected page skips identity retrieval. Query count does not grow with page size, and the service does not issue extra queries to refill items omitted during hydration.

Feed selection and hydrated source retrieval share one PostgreSQL statement snapshot. Identity data is a later current-state read, so actor/profile changes may be reflected after page selection without changing source ordering.

A source-aware query count-bounds selected rows to `limit + 1` (at most 51), but it does not byte-bound their source JSON. Large indexed records can increase PostgreSQL transfer, process memory, validation work, and latency. Source JSON remains internal and is never serialized in the view-only hydrated response.

## Runtime configuration

Copy `.env.example` to `.env` for local development, or copy its values into the deployment's variable configuration. The process loads an optional local `.env` without overriding variables already provided by the environment.

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `DATABASE_URL` | yes | | Dedicated read-only Postgres URL for the Hyperindex database |
| `PORT` | no | `3000` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen interface |
| `LOG_LEVEL` | no | `info` | Pino log level |
| `DATABASE_MAX_CONNECTIONS` | no | `5` | Maximum pool size, capped at 20; the pool keeps one connection warm |
| `DATABASE_IDLE_TIMEOUT_MS` | no | `60000` | Time before idle connections above the one-connection minimum are closed |
| `DATABASE_CONNECTION_TIMEOUT_MS` | no | `2000` | Pool acquisition timeout |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | `5000` | PostgreSQL statement timeout |
| `REQUEST_TIMEOUT_MS` | no | `10000` | Maximum time allowed to receive an HTTP request; not a handler or database deadline |
| `GRACEFUL_SHUTDOWN_MS` | no | `10000` | Shutdown drain timeout |
| `TRUSTED_QUALITY_LABELER_DIDS` | no | empty | Comma-separated Orglabeler trust roots |

If no trusted labelers are configured, known organizations are unrated whenever an organization-quality policy is supplied.

## Database access

Use a dedicated login with only `SELECT` access. The service also sets `default_transaction_read_only=on` on every pool session, but grants remain the primary boundary.

Each replica owns a bounded in-process pool. Account for `replica count × DATABASE_MAX_CONNECTIONS` when budgeting database connections; use an external pooler when many replicas share a constrained PostgreSQL server.

Example operator setup:

```sql
CREATE ROLE certified_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE hyperindex TO certified_feed_reader;
GRANT USAGE ON SCHEMA public TO certified_feed_reader;
GRANT SELECT ON TABLE public.record, public.actor, public.external_label
  TO certified_feed_reader;
ALTER ROLE certified_feed_reader SET default_transaction_read_only = on;
```

The service owns no migrations or feed tables. `/ready` checks database reachability, PostgreSQL 16 timestamp validation, and read-only session state; it does not inspect Hyperindex tables, migrations, label subscriptions, backfill completion, or ingestion freshness. See [`docs/database-contract.md`](docs/database-contract.md) for the runtime schema contract.

Before cutover, verify trusted quality-label subscriptions are healthy and current, migration-010 timestamp backfill is complete, and Hyperindex filters/backfill include `app.certified.actor.profile`, `app.bsky.actor.profile`, and `org.hyperboards.board`.

## Development

Requires Node.js 22+ and PostgreSQL 16+.

```bash
npm install
npm run codegen
npm run check
npm run test:unit
npm run build
```

Committed Lexicon JSON under `lexicons/` is the public wire contract plus installed external dependencies. `lexicons.json` pins installed network Lexicons by AT-URI and CID. Generated TypeScript under `src/lexicons/` is ignored and must not be edited or committed. `codegen`, `check`, tests, and build regenerate it. Codegen stages only the canonical `org.hypercerts.defs#uri`, `#smallBlob`, `#smallImage`, and `#largeImage` fragments from the pinned `@hypercerts-org/lexicon` package so the feed does not commit duplicate definitions. A narrow post-codegen workaround for `@atproto/lex@0.3.0` is documented in `AGENTS.md`.

Verify committed network Lexicons against the manifest with:

```bash
npx --no-install lex install --ci --lexicons ./lexicons --manifest ./lexicons.json
```

Use `lex install --update` only when intentionally refreshing those pinned dependencies.

The canonical feed statement is `src/feed/feed-query.sql`. Development watches it with the TypeScript sources, and build copies it beside `dist/feed/query.js` before smoke-loading production adapters.

### PostgreSQL integration tests

Integration tests require an explicitly selected empty disposable PostgreSQL 16+ database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/certified_feed_test' \
  npm run test:integration
```

The suite creates minimal contractual tables and test rows but does not drop or truncate existing tables. Never point it at a shared, staging, or production database.

To verify against Hyperindex's migrated schema, first let Hyperindex migrate a separate disposable database that is otherwise empty of application rows:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

This command requires `psql`, verifies required Hyperindex migrations, record/actor/external-label columns, the generated `record.rkey`, and the external-label lookup index, then runs the same behavior suite. It does not apply Hyperindex migrations.

## Deployment

```bash
docker build -t certified-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e TRUSTED_QUALITY_LABELER_DIDS='did:plc:ar7c4by46qjdydhdevvrndac' \
  certified-feed-service
```

Deploy beside Hyperindex with private database networking.

Apply per-IP rate limiting at the gateway. The initial public policy is 60 feed requests per minute per client IP with a burst of 20, returning HTTP 429 and `Retry-After` when exceeded. Keep health, readiness, and metrics private and outside that public bucket. Tune limits from measured query latency and pool saturation.

The process bounds request bodies, HTTP receive time, pool size, connection acquisition, and SQL statement duration. `REQUEST_TIMEOUT_MS` is not an end-to-end handler or query deadline. Do not add inconsistent per-replica rate-limit state to this service.

## Operations

- `GET /health`: process liveness only.
- `GET /ready`: live database capability and read-only check; runtime schema compatibility is documented separately.
- `GET /metrics`: Prometheus metrics.
- `SIGTERM` and `SIGINT`: stop accepting requests, drain, then close the database pool.

Metrics use bounded route, status, operation, event-kind, and error labels. DIDs, AT-URIs, CIDs, cursors, and record values are never labels.

Stable public feed errors:

```text
InvalidRequest
TrustedEvaluatorsTooLarge
FeedScopeTooLarge
InvalidKind
InvalidCursor
InternalError
```

Public errors never include SQL, database credentials, table contents, internal causes, or stack traces.

## MVP boundaries

The service does not ingest, authenticate, write records, own migrations, cache across requests, call Hyperindex/PDS/AppView APIs, download blobs, hydrate target records, build target previews, recursively hydrate linked records, persist preferences, discover the network, or provide immutable event history. Results reflect Hyperindex's mutable current state and freshness.
