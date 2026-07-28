# Certified Feed Service

Standalone TypeScript sidecar that reads Hyperindex's current PostgreSQL state and returns an ordered, paginated Hypercerts feed skeleton.

The service does not ingest, copy, hydrate, or mutate indexed data. Hyperindex is the only supported database owner. This service queries its PostgreSQL tables directly; it does not import Hyperindex code, call its GraphQL API, or apply its migrations.

## Endpoint

```text
POST /xrpc/app.certified.feed.beta.getFeedSkeleton
Content-Type: application/json
```

This is an unauthenticated, app-specific XRPC procedure, not the Bluesky `app.bsky.feed.getFeedSkeleton` query. The request's `viewerDid` selects the viewer scope and is not verified against an authenticated caller. `certified.app` or the Hypercerts data plane calls it directly, then hydrates each returned URI and CID.

```bash
curl -sS http://localhost:3000/xrpc/app.certified.feed.beta.getFeedSkeleton \
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

Example response:

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

The cursor is opaque to callers and is valid only for descending effective-timestamp pagination.

## Request flow

```mermaid
sequenceDiagram
    actor Client as ATProto Client
    participant HTTP as HTTP App
    participant XRPC as XRPC Handler
    participant Service as Feed Service
    participant Repo as Feed Repository
    participant DB as Hyperindex PostgreSQL

    Client->>HTTP: POST getFeedSkeleton
    HTTP->>XRPC: Validated request
    XRPC->>Service: getFeedSkeleton(input)
    Service->>Service: Normalize request and decode cursor
    Service->>Repo: getFeed(request)
    Repo->>DB: Execute parameterized feed query
    DB-->>Repo: Classified feed rows
    Repo-->>Service: Mapped query result
    Service->>Service: Paginate and create cursor
    Service-->>XRPC: Feed skeleton
    XRPC-->>HTTP: XRPC response
    HTTP-->>Client: Items and optional cursor
```

## Request behavior

- Malformed JSON or an invalid `viewerDid` returns HTTP 400 with `InvalidRequest`; it never becomes an internal server error.
- The base scope always comes from the viewer's current `app.certified.graph.follow` records; malformed follow subjects are ignored.
- `trustedEvaluators` adds subjects of each evaluator's current active endorsement awards.
- Endorsement definitions without `allowedIssuers` permit any issuer. When present, only listed issuer DIDs qualify; an empty list permits none, and malformed values are ignored safely.
- The viewer is removed. Hyperindex's identity lifecycle purges source records for explicitly deleted, deactivated, suspended, or taken-down identities; the feed does not query actor status.
- Organization-quality policy runs against the final author union before selecting events. An organization is detected only by its exact `app.certified.actor.organization/self` record.
- Trusted organization-quality labels are bare-DID, non-CID subjects from Hyperindex's `external_label` table; record-level and CID-specific labels do not count.
- Omitted or empty `kinds` includes all supported kinds.
- Unknown kinds are rejected instead of silently ignored.

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

Project and activity records fold before kind filtering and pagination. A paired activity therefore cannot leak onto a later page after its collection was returned as `project.created_with_cert`.

## Ordering

Hyperindex materializes a valid top-level `json.createdAt` into `record.record_created_at`. The feed orders by `record_created_at`, falling back to `record.indexed_at` when the materialized value is null.

Ordering is:

```text
COALESCE(record_created_at, indexed_at) DESC, record URI DESC
```

Cursor version 1 stores that effective timestamp and the record URI.

The SQL pipeline classifies and folds all eligible records before kind filtering, keyset filtering, ordering, and `LIMIT`. It fetches `limit + 1` matching events to decide whether a next cursor should be returned.

## Runtime configuration

Copy `.env.example` to `.env` for local development, or copy its values into your deployment's variable configuration. The process loads an optional local `.env` file at startup without overriding variables already provided by the environment.

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `DATABASE_URL` | yes | | Dedicated read-only Postgres URL for the indexer database |
| `PORT` | no | `3000` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen interface |
| `LOG_LEVEL` | no | `info` | Pino log level |
| `DATABASE_MAX_CONNECTIONS` | no | `5` | Maximum pool size, capped at 20; the pool keeps one connection warm |
| `DATABASE_IDLE_TIMEOUT_MS` | no | `60000` | Time before idle connections above the one-connection minimum are closed |
| `DATABASE_CONNECTION_TIMEOUT_MS` | no | `2000` | Pool acquisition timeout |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | `5000` | Postgres statement timeout |
| `REQUEST_TIMEOUT_MS` | no | `10000` | Maximum time allowed to receive an HTTP request; not a handler or database deadline |
| `GRACEFUL_SHUTDOWN_MS` | no | `10000` | Shutdown drain timeout |
| `TRUSTED_QUALITY_LABELER_DIDS` | no | empty | Comma-separated Orglabeler trust roots |

Trusted quality labelers are service configuration. Callers cannot choose label sources. If no labelers are configured, known organizations are unrated whenever an organization-quality policy is supplied.

## Database access

Use a dedicated login with only `SELECT` access. The service also sets `default_transaction_read_only=on` on every pool session, but grants remain the primary boundary.

Each service replica maintains its own bounded in-process pool. The initial readiness check opens a connection, the pool retains one warm connection to avoid reconnect churn, and idle connections above that minimum close after `DATABASE_IDLE_TIMEOUT_MS`. Account for `replica count × DATABASE_MAX_CONNECTIONS` when budgeting database connections; use an external pooler when many independently scaling replicas share a constrained Postgres server.

Example operator setup:

```sql
CREATE ROLE certified_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE hyperindex TO certified_feed_reader;
GRANT USAGE ON SCHEMA public TO certified_feed_reader;
GRANT SELECT ON public.record, public.external_label
  TO certified_feed_reader;
ALTER ROLE certified_feed_reader
  SET default_transaction_read_only = on;
```

The service owns no migrations or feed tables. `/ready` checks database reachability, PostgreSQL 16 timestamp validation, and read-only session state; it does not inspect Hyperindex tables, migrations, label-subscription health, timestamp-backfill completion, or ingestion freshness. The feed still requires the documented runtime schema. See [`docs/database-contract.md`](docs/database-contract.md).

Before cutover, operators must verify that every trusted quality-labeler DID maps to a healthy, caught-up Hyperindex subscription; the migration-010 `record_created_at` backfill is complete; and Hyperindex's Tap filters/backfill include `org.hyperboards.board`. Live Hyperboard classification remains unvalidated when the target database contains no source Hyperboard records.

## Development

Requires Node.js 22+ and Postgres 16+.

```bash
npm install
npm run codegen
npm run check
npm run test:unit
npm run build
```

Generated Lexicon TypeScript lives under `src/lexicons/` and is intentionally ignored. The canonical `com.atproto.repo.strongRef` schema is vendored under `lexicons/com/atproto/repo/strongRef.json`. `codegen`, `build`, `check`, and test scripts regenerate ignored output from the committed JSON Lexicons; run `npm run codegen` after changing them.

The canonical feed statement lives in `src/feed/feed-query.sql`. `npm run dev` watches it alongside the TypeScript sources, and the build copies it beside `dist/feed/query.js` before smoke-testing that the production adapter loads.

### Postgres integration tests

Integration tests never connect to a deployment automatically. Point them at an empty disposable Postgres 16+ database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/certified_feed_test' \
  npm run test:integration
```

The test creates the minimal contractual tables in that disposable database. It does not drop or truncate existing tables, so do not point it at a shared or production database. `npm run test:integration` fails when `TEST_DATABASE_URL` is missing, and the committed CI workflow runs it against Postgres 16.

To verify against Hyperindex's real migration set, first let Hyperindex migrate a disposable database that is otherwise empty of application rows, then run:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

This compatibility command requires `psql`, verifies the required Hyperindex migrations, columns, generated `record.rkey`, and external-label active lookup index, then executes the same feed behavior suite. It does not apply Hyperindex migrations.

## Deployment

Build and run the included image:

```bash
docker build -t certified-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e TRUSTED_QUALITY_LABELER_DIDS='did:plc:ar7c4by46qjdydhdevvrndac' \
  certified-feed-service
```

Deploy it beside Hyperindex with private database networking. It is a separate process and repository, even when both services share a deployment environment.

Apply per-IP rate limiting at the gateway. The initial public policy is 60 feed requests per minute per client IP with a burst of 20, returning HTTP 429 and `Retry-After` when exceeded. Health, readiness, and metrics should stay on private operator routes and outside that public bucket. Tune the threshold from measured query latency and pool saturation before increasing it. The process bounds request bodies, HTTP request receive time, pool size, connection acquisition, and SQL statement duration. `REQUEST_TIMEOUT_MS` is not an end-to-end handler or database deadline. The process intentionally does not maintain inconsistent per-replica rate-limit state in process.

## Operations

- `GET /health`: process liveness only.
- `GET /ready`: live database capability and read-only check; runtime schema compatibility is documented separately.
- `GET /metrics`: Prometheus metrics.
- `SIGTERM` and `SIGINT`: stop accepting requests, drain, then close the database pool.

Metrics use only bounded route, status, operation, event-kind, and error labels. Viewer DIDs, author DIDs, evaluator DIDs, URIs, and cursors are never metric labels.

Stable public feed errors:

```text
InvalidRequest
TrustedEvaluatorsTooLarge
InvalidKind
InvalidCursor
InternalError
```

Public errors do not include SQL, database credentials, table contents, or internal stack traces.

## MVP boundaries

This service does not provide record hydration, blobs, actor profiles, rendered feed sentences, preference persistence, authentication, writes, ingestion, network-wide discovery, or an immutable event history. Results reflect the indexer's current mutable state and freshness.
