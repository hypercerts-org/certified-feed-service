# Certified Feed Service

A standalone, read-only TypeScript service. It reads the current PostgreSQL data owned by Hyperindex and serves ordered Hypercerts feeds over XRPC.

> **Pre-release:** Neither this service nor its Lexicons has had a first public release. Wire contracts can change without backward compatibility.

Hyperindex is the only supported owner of the database. The service provides a URI-only skeleton and a hydrated feed with generic entries and feed-specific views. It does not ingest or change indexed data, import Hyperindex code, call the Hyperindex GraphQL API, authenticate callers, fetch blob bytes, or provide an unchangeable event history.

## Endpoints

Both endpoints are unauthenticated POST procedures. They use the same `{ feedId, params?, limit?, cursor? }` request wrapper, feed-scoped cursor contract, and stable public errors. `params` contains only algorithm-specific values; pagination is generic and top-level. The registered Certified feed requires `params.viewerDid` to choose the viewer scope. The service does not check it against an authenticated caller:

```text
POST /xrpc/app.certified.feed.beta.getFeedSkeleton
POST /xrpc/app.certified.feed.beta.getFeed
Content-Type: application/json
```

These are app-specific XRPC procedures. They are not Bluesky's `app.bsky.feed.getFeedSkeleton` query.

### Request

```bash
curl -sS http://localhost:3000/xrpc/app.certified.feed.beta.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "app.certified.feed.beta.defs#certifiedFeed",
    "params": {
      "$type": "app.certified.feed.beta.defs#certifiedFeedParams",
      "viewerDid": "did:plc:ar7c4by46qjdydhdevvrndac",
      "trustedEvaluators": ["did:plc:ewvi7nxzyoun6zhxrhs64oiz"],
      "organizationQuality": {
        "allowed": ["high-quality", "standard"],
        "includeUnrated": false
      }
    },
    "limit": 20
  }'
```

Use the same body with `getFeedSkeleton` when another data system needs only ordered source AT-URIs. The public params union is open for future feed algorithms, including algorithms that accept no params. This service currently registers only `app.certified.feed.beta.defs#certifiedFeed` and requires `app.certified.feed.beta.defs#certifiedFeedParams`; missing params or a mismatched `$type` returns `InvalidRequest`, while an unknown `feedId` returns `UnsupportedFeed`.

### Skeleton response

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.claim.activity/3kpn"
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjoxLCJmZWVkSWQiOiJhcHAuY2VydGlmaWVkLmZlZWQuYmV0YS5kZWZzI2NlcnRpZmllZEZlZWQiLCJ2YWx1ZSI6eyJ2YWx1ZSI6IjIwMjYtMDctMjFUMTA6MDA6MDAuMDAwMDAwWiIsInVyaSI6ImF0Oi8vZGlkOnBsYzpld3ZpN254enlvdW42emh4cmhzNjRvaXovb3JnLmh5cGVyY2VydHMuY2xhaW0uYWN0aXZpdHkvM2twbiJ9fQ"
}
```

Each skeleton entry intentionally contains only the source record AT-URI. A downstream hydrator resolves the current indexed record version; the skeleton does not pin hydration to a CID or expose feed-specific classification metadata. Send a returned cursor back as the top-level request `cursor`, never inside algorithm-specific `params`.

### Hydrated response

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.context.evaluation/3kpn",
      "view": {
        "$type": "app.certified.feed.beta.defs#certifiedFeedView",
        "kind": "evaluation.create",
        "actor": {
          "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
          "handle": "evaluator.example",
          "displayName": "Evaluator"
        },
        "content": {
          "$type": "app.certified.feed.beta.defs#evaluationView",
          "summary": "Strong evidence",
          "createdAt": "2026-07-21T10:00:00.000Z",
          "target": {
            "uri": "at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/target",
            "cid": "bafyreifxcn6ts5hr6oequ5w5jyrpwrdl6p5lq46jasnxmcw3h3sme6asru"
          }
        }
      }
    }
  ]
}
```

Every hydrated entry has a generic source `subject` and an open `view` union. The current `certifiedFeedView` variant owns the Certified event kind, actor, and kind-specific content. Clients must tolerate unknown future feed-view and content variants.

#### What you get

Every hydrated feed entry comes from a valid source record. Each entry has a feed-specific view and kind-specific content.

The service uses an actor's Certified profile for their name and avatar when it can. Otherwise, it uses their Bluesky profile. It adds a valid handle separately. If there is no profile, it shows the actor by their handle or DID.

An evaluation, measurement, or update may point to another record by its exact URI and CID. These targets remain strong references even though the entry's source `subject` is URI-only. The service checks that each target reference is valid.

Clients must accept image and feed formats they do not know. Known images keep their original Hypercerts and AT Protocol formats.

#### What the service does not do

The service removes invalid feed items and does not replace them. A page may therefore have fewer items than requested, or no items. The cursor still advances past every record the service checked.

The response never contains the original source JSON. It also does not say where actor details came from.

The service does not fetch, preview, or expand linked records. It only checks that the link contains a valid URI and CID.

The service does not contact a PDS or AppView. It does not download or proxy image files. It gets Bluesky profile data from the indexed database.

## Request flow

```mermaid
sequenceDiagram
    actor Client
    participant HTTP as HTTP App
    participant XRPC as XRPC Handler
    participant Service as FeedService / HydratedFeedService
    participant Registry as Feed Registry
    participant Feed as Registered SQL Feed
    participant Identity as Identity Reader
    participant DB as Hyperindex PostgreSQL

    Client->>HTTP: POST feed procedure
    HTTP->>XRPC: Bounded, validated JSON
    XRPC->>Service: Endpoint input
    Service->>Registry: Load metadata or source-aware page
    Registry->>Feed: Dispatch feedId, optional params, and pagination
    Feed->>DB: One normalized Hyperindex selection statement
    DB-->>Feed: Scope and limit+1 metadata or exact sources
    Feed-->>Registry: Selected page and feed-scoped cursor
    Registry-->>Service: Selected page and cursor
    alt Hydrated endpoint
        Service->>Service: Validate sources and omit invalid rows
        Service->>Identity: Requested actor DIDs when needed
        Identity->>DB: One actor/profile batch
        DB-->>Identity: Current identity contexts
        Identity-->>Service: Complete DID map
        Service-->>XRPC: Generic entries, feed-specific views, and selected-page cursor
    else Skeleton endpoint
        Service-->>XRPC: URI-only subjects and cursor
    end
    XRPC-->>HTTP: Procedure response
    HTTP-->>Client: JSON response
```

## Request behavior

- Malformed JSON, missing required params, an invalid nested `viewerDid`, params that do not match the selected feed, or structurally invalid top-level pagination return HTTP 400 with `InvalidRequest`. Semantically invalid selected-feed parameters or pagination beyond that feed's supported range return HTTP 422 with the same generic error name and an actionable message. An unregistered `feedId` returns `UnsupportedFeed`. These never become internal server errors.
- The base scope always comes from the viewer's current `app.certified.graph.follow` records. The service ignores malformed follow subjects.
- `trustedEvaluators` adds the subjects of every current, active endorsement award from each evaluator.
- An endorsement definition with no `allowedIssuers` allows any issuer. When it is present, only its listed issuer DIDs qualify. An empty or malformed value allows no issuers.
- The service removes the viewer. Hyperindex removes source records for identities that are explicitly deleted, deactivated, suspended, or taken down, so feed selection does not check actor status.
- The organization-quality rules run against the final combined author list before event selection. Only exact `app.certified.actor.organization/self` records count as organizations.
- Trusted quality labelers come only from the service configuration. Quality labels are bare-DID, non-CID `external_label` rows. Callers cannot choose label sources.
- Leaving out `kinds`, or passing an empty list, includes every supported kind. Unknown kinds are rejected as `InvalidRequest`.

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

Project and activity records are combined before kind filtering and pagination. After a collection is returned as `project.created_with_cert`, its paired activity cannot appear on a later page.

## Ordering and current-state behavior

The order is:

```text
feed timestamp DESC, record URI DESC
```

Entries appear newest first using an internal feed timestamp. It uses the record's valid `createdAt`; otherwise, it uses the time when Hyperindex indexed the record. The timestamp is not exposed in either response. Pagination moves forward from the last source row chosen before hydration, so removing an invalid hydrated entry does not move the cursor.

### Pagination and database reads

**Pages**

- The service checks one extra item to see whether another page exists.
- The cursor marks the last item selected and is valid only for the `feedId` that issued it.
- Both endpoints use the same top-level pagination, ordering, and feed-scoped cursor rules.
- Invalid hydrated entries are removed, not replaced.

**Database work**

- A skeleton page uses one database query.
- A full feed page also loads actor and profile details when it has valid entries.
- The service never makes extra queries to fill gaps left by invalid entries.

**Freshness**

Feed entries and their source records are read together. Actor and profile details are loaded afterward, so they may be newer.

Each page is a separate database read. Changes made between requests may appear on later pages.

**Record size**

The service reads at most 51 source records per page. Their total size is not limited, so unusually large records may take longer and use more memory.

Source JSON is never returned.

## Runtime configuration

For local development, copy `.env.example` to `.env`. For deployment, copy its values into the deployment's variable configuration. The process can load a local `.env`, but it never replaces variables already set in the environment.

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

If there are no configured trusted labelers, known organizations count as unrated whenever the request includes an organization-quality policy.

## Database access

Use a dedicated login that has only `SELECT` access. The service also sets `default_transaction_read_only=on` for every connection in the pool, but database grants are still the main security boundary.

Each service replica has its own limited in-process pool. When planning database connections, allow for `replica count × DATABASE_MAX_CONNECTIONS`. Use an external pooler if many replicas share a PostgreSQL server with few available connections.

Example operator setup:

```sql
CREATE ROLE certified_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE hyperindex TO certified_feed_reader;
GRANT USAGE ON SCHEMA public TO certified_feed_reader;
GRANT SELECT ON TABLE public.record, public.actor, public.external_label
  TO certified_feed_reader;
ALTER ROLE certified_feed_reader SET default_transaction_read_only = on;
```

The service has no migrations or feed tables of its own. `/ready` checks that the database can be reached, PostgreSQL 16 can validate timestamps, and the session is read-only. It does not check Hyperindex tables, migrations, label subscriptions, completed backfills, or ingestion freshness. See [`docs/database-contract.md`](docs/database-contract.md) for the runtime schema contract.

Before cutover, confirm that trusted quality-label subscriptions are healthy and current, the migration-010 timestamp backfill is complete, and the Hyperindex filters and backfill include `app.certified.actor.profile`, `app.bsky.actor.profile`, and `org.hyperboards.board`.

## Development

You need Node.js 22+ and PostgreSQL 16+.

```bash
npm install
npm run codegen
npm run check
npm run test:unit
npm run build
```

The committed Lexicon JSON in `lexicons/` defines the public wire contract and includes installed external dependencies. `lexicons.json` pins installed network Lexicons by AT-URI and CID. The generated TypeScript in `src/lexicons/` is ignored. Do not edit or commit it. The `codegen`, `check`, test, and build commands regenerate it. Codegen stages only the standard `org.hypercerts.defs#uri`, `#smallBlob`, `#smallImage`, and `#largeImage` fragments from the pinned `@hypercerts-org/lexicon` package. This keeps the feed from committing duplicate definitions. `AGENTS.md` explains a small, focused workaround that runs after codegen for `@atproto/lex@0.3.0`.

Check the committed network Lexicons against the manifest with:

```bash
npx --no-install lex install --ci --lexicons ./lexicons --manifest ./lexicons.json
```

Run `lex install --update` only when you mean to update those pinned dependencies.

The main feed statement is `src/feed/feed-query.sql`. `src/feed/query.ts` registers its Certified feed definition, while `src/feed/registry.ts` and `src/feed/sql-feed.ts` own dispatch and shared SQL-feed execution policy. During development, the watcher watches the SQL along with the TypeScript source. The build copies it next to `dist/feed/query.js` before checking that the production adapters load.

### PostgreSQL integration tests

Integration tests need a PostgreSQL 16+ database that you explicitly choose and that is empty and safe to discard:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/certified_feed_test' \
  npm run test:integration
```

The test suite creates the smallest needed contract tables and test rows. It does not drop or empty existing tables. Never point it at a shared, staging, or production database.

To test against Hyperindex's migrated schema, first have Hyperindex migrate a separate disposable database that otherwise contains no application rows:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/hyperindex_feed_test' \
  npm run test:integration:hyperindex
```

This command needs `psql`. It checks the required Hyperindex migrations, the record, actor, and external-label columns, the generated `record.rkey`, and the external-label lookup index. It then runs the same behavior tests. It does not apply Hyperindex migrations.

## Deployment

```bash
docker build -t certified-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e TRUSTED_QUALITY_LABELER_DIDS='did:plc:ar7c4by46qjdydhdevvrndac' \
  certified-feed-service
```

Deploy the service beside Hyperindex and use private networking for the database.

Set per-IP rate limits at the gateway. The first public policy allows 60 feed requests per minute for each client IP, with a burst of 20. When a client exceeds the limit, return HTTP 429 with `Retry-After`. Keep health, readiness, and metrics private and outside this public limit. Adjust the limits using measured query response time and pool saturation.

The process limits request body size, HTTP request receive time, pool size, connection wait time, and SQL statement duration. `REQUEST_TIMEOUT_MS` is not a deadline for the whole handler or query. Do not add rate-limit state to this service because separate replicas would disagree.

## Operations

- `GET /health`: checks only whether the process is alive.
- `GET /ready`: checks current database support and read-only state; the runtime schema contract is documented separately.
- `GET /metrics`: provides Prometheus metrics.
- `SIGTERM` and `SIGINT`: stop accepting requests, let current work finish, and then close the database pool.

Metrics use a fixed set of route, status, operation, event-kind, and error labels. DIDs, AT-URIs, CIDs, cursors, and record values are never used as labels.

Stable public feed errors:

```text
InvalidRequest
UnsupportedFeed
InvalidCursor
InternalError
```

Feed-specific parameter failures use `InvalidRequest`; their message identifies the invalid parameter and how to correct it.

Public errors never show SQL, database credentials, table contents, internal causes, or stack traces.

## MVP boundaries

The service does not ingest data, authenticate callers, write records, manage migrations, cache across requests, call Hyperindex/PDS/AppView APIs, download blobs, hydrate target records, build target previews, recursively hydrate linked records, save preferences, discover the network, or provide an unchangeable event history. Results show Hyperindex's current, changeable data and its current freshness.
