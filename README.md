# Certified Feed Service

Standalone, read-only TypeScript service that reads Magic Indexer's current PostgreSQL state and serves ordered Hypercerts feeds over XRPC.

The service exposes an exact-reference skeleton and a view-only hydrated feed. It does not ingest or mutate indexed data, call Magic Indexer's API, authenticate callers, fetch blob bytes, or provide immutable event history.

## Endpoints

Both endpoints are unauthenticated POST procedures with the same request fields, limits, cursor contract, and stable public errors:

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
  "cursor": "eyJ2ZXJzaW9uIjoyLCJ2YWx1ZSI6IjIwMjYtMDctMjFUMTA6MDA6MDAuMDAwMDAwWiIsInVyaSI6ImF0Oi8vZGlkOnBsYzpld3ZpN254enlvdW42emh4cmhzNjRvaXovb3JnLmh5cGVyY2VydHMuY2xhaW0uYWN0aXZpdHkvM2twbiJ9"
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
      "recordState": "available",
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

- `available` means the selected source validated and the item has a kind-specific `view`.
- `invalid` retains page metadata and the event-author summary but omits `view`.
- The response does not expose source JSON or identity provenance.
- Actor summaries use a valid meaningful Certified profile first, otherwise validated stored Bluesky fields, otherwise the DID alone. A valid stored handle is preserved independently.
- Evaluation, measurement, and update views may include an exact `{ uri, cid }` target. The source record's authoritative validator validates the strong-reference shape. The service does not query, preview, recursively hydrate, or validate the referenced target record or body.
- Image values are URI or blob descriptors. The service never fetches or proxies bytes.

## Request behavior

- Malformed JSON returns HTTP 400 with `INVALID_REQUEST`; it never becomes an internal server error.
- Omitted `authors` resolves the viewer's current `app.certified.graph.follow` records; malformed follow subjects are ignored.
- `authors: []` selects an empty base. It never means every indexed author.
- Explicit `authors` replaces only the direct-follow base.
- `trustedEvaluators` adds subjects of each evaluator's current active endorsement awards.
- Endorsement definitions without `allowedIssuers` permit any issuer. When present, only listed issuer DIDs qualify; an empty or malformed value permits none.
- The viewer and known inactive actors are removed.
- Organization-quality policy runs against the final author union before selecting events.
- Trusted quality labelers come only from service configuration; callers cannot choose label sources.
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

A valid top-level string `json.createdAt` supplies the effective timestamp. Missing, malformed, non-string, or PostgreSQL-invalid values fall back to `record.sort_at`. The query fetches `limit + 1` events to decide whether to return a next cursor.

The opaque cursor stores the last emitted timestamp and URI. Both endpoints use the same page loader, so ordering and cursor bytes are identical for the same request. Cursor traversal is deterministic for each query but does not provide snapshot isolation across requests.

For a skeleton request, the service performs one feed query. For a non-empty hydrated request, it performs one feed/source statement plus one identity batch. An empty hydrated page skips identity retrieval. Query count does not grow with page size.

Feed selection and hydrated source retrieval share one PostgreSQL statement snapshot. Identity data is a later current-state read, so actor/profile changes may be reflected after page selection without dropping or reordering the selected event.

A source-aware query count-bounds selected rows to `limit + 1` (at most 51), but it does not byte-bound their source JSON. Large indexed records can increase PostgreSQL transfer, process memory, validation work, and latency. Source JSON remains internal and is never serialized in the view-only hydrated response.

## Runtime configuration

Copy `.env.example` to `.env` for local development, or copy its values into the deployment's variable configuration. The process loads an optional local `.env` without overriding variables already provided by the environment.

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `DATABASE_URL` | yes | | Dedicated read-only Postgres URL for the indexer database |
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
GRANT SELECT ON TABLE public.record, public.actor, public.label
  TO certified_feed_reader;
ALTER ROLE certified_feed_reader SET default_transaction_read_only = on;
```

The service owns no migrations or feed tables. `/ready` checks database reachability, PostgreSQL 16 timestamp validation, and read-only session state; it does not inspect Magic Indexer tables or columns. See [`docs/database-contract.md`](docs/database-contract.md) for the runtime schema contract.

## Development

Requires Node.js 22+ and PostgreSQL 16+.

```bash
npm install
npm run codegen
npm run check
npm run test:unit
npm run build
```

Committed Lexicon JSON under `lexicons/` is the public wire contract. Generated TypeScript under `src/lexicons/` is ignored and must not be edited or committed. `codegen`, `check`, tests, and build regenerate it. A narrow post-codegen workaround for `@atproto/lex@0.3.0` is documented in `AGENTS.md`.

The canonical feed statement is `src/feed/feed-query.sql`. Development watches it with the TypeScript sources, and build copies it beside `dist/feed/query.js` before smoke-loading production adapters.

### PostgreSQL integration tests

Integration tests require an explicitly selected empty disposable PostgreSQL 16+ database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/certified_feed_test' \
  npm run test:integration
```

The suite creates minimal contractual tables and test rows but does not drop or truncate existing tables. Never point it at a shared, staging, or production database.

To verify against Magic Indexer's migrated schema:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/magic_feed_test' \
  npm run test:integration:magic
```

This command verifies required migration versions and runs the same behavior suite. It does not apply Magic Indexer migrations.

## Deployment

```bash
docker build -t certified-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e TRUSTED_QUALITY_LABELER_DIDS='did:plc:ar7c4by46qjdydhdevvrndac' \
  certified-feed-service
```

Deploy beside Magic Indexer or Hyperindex with private database networking.

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
INVALID_REQUEST
INVALID_VIEWER
AUTHORS_FILTER_TOO_LARGE
TRUSTED_EVALUATORS_TOO_LARGE
FEED_SCOPE_TOO_LARGE
INVALID_KIND
INVALID_CURSOR
INTERNAL_ERROR
```

Public errors never include SQL, database credentials, table contents, internal causes, or stack traces.

## MVP boundaries

The service does not ingest, authenticate, write records, own migrations, cache across requests, call Magic Indexer APIs, call PDS/AppView profile APIs, download blobs, hydrate target records, build target previews, recursively hydrate linked records, persist preferences, discover the network, or provide immutable event history. Results reflect Magic Indexer's mutable current state and freshness.
