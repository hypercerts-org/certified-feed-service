import { readFileSync } from 'node:fs'

import type { QueryResultRow } from 'pg'

import type { FeedCursor } from './cursor.js'
import { FEED_COLLECTIONS } from './types.js'
import type {
  FeedKind,
  NormalizedFeedRequest,
  OrganizationQuality,
} from './types.js'

/** Maximum resolved author scope permitted before event expansion is suppressed. */
export const MAX_RESOLVED_AUTHOR_COUNT = 500

const FEED_QUERY = readFileSync(
  new URL('./feed-query.sql', import.meta.url),
  'utf8',
)

interface FeedQueryRow extends QueryResultRow {
  scope_count: number
  uri: string | null
  cid: string | null
  collection: string | null
  actor_did: string | null
  kind: FeedKind | null
  sort_value: string | null
  selected_source_uri: string | null
  selected_source_cid: string | null
  selected_source_collection: string | null
  source_json: unknown
}

/** Narrow structural query capability used by the feed repository. */
export interface FeedQueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** Parameters consumed by the standalone SQL adapter. */
export interface FeedQueryInput {
  /** Validated and normalized public request. */
  readonly request: NormalizedFeedRequest
  /** Validated keyset cursor, if this is not the first page. */
  readonly cursor?: FeedCursor
  /** Trusted service-configured Orglabeler DIDs. */
  readonly trustedQualityLabelerDids: readonly string[]
  /** Whether the final page rows must include exact same-statement source values. */
  readonly includeSource: boolean
}

/** One classified database row before the loader trims the limit+1 sentinel. */
export interface FeedQueryMetadataRow {
  readonly uri: string
  readonly cid: string
  readonly actorDid: string
  readonly collection: string
  readonly kind: FeedKind
  readonly sortValue: string
}

/** One classified database row with its exact selected source value. */
export interface FeedQuerySourceRow extends FeedQueryMetadataRow {
  readonly sourceValue: unknown
}

interface FeedQueryResultBase {
  /** Number of accounts remaining after all scope membership rules. */
  readonly scopeCount: number
}

/** Metadata-only result returned when source values were not requested. */
export interface MetadataFeedQueryResult extends FeedQueryResultBase {
  readonly includeSource: false
  readonly rows: readonly FeedQueryMetadataRow[]
}

/** Source-aware result returned for hydrated page loading. */
export interface SourceFeedQueryResult extends FeedQueryResultBase {
  readonly includeSource: true
  readonly rows: readonly FeedQuerySourceRow[]
}

/** One database result before the loader trims the limit+1 sentinel row. */
export type FeedQueryResult = MetadataFeedQueryResult | SourceFeedQueryResult

/** Seam used by the shared page loader to execute the database-owned feed pipeline. */
export interface FeedQueryReader {
  /** Resolves a feed request into a scope count and limit+1 classified rows. */
  getFeed(input: FeedQueryInput): Promise<FeedQueryResult>
}

const metadataInvariantError = (): Error =>
  new Error(
    'Feed query metadata invariant failed: a page row contained incomplete URI, CID, collection, actor DID, kind, or sort metadata; verify the feed SQL projection before serving feed requests.',
  )

const sourceInvariantError = (): Error =>
  new Error(
    'Feed query source invariant failed: a selected page row did not include the exact URI, CID, and collection from the post-pagination source join; verify the feed SQL projection and bind order before serving hydrated pages.',
  )

/** Read-only adapter that owns the complete current-state feed query. */
export class FeedRepository implements FeedQueryReader {
  /** Creates the adapter over the service's bounded read-only pool. */
  constructor(private readonly database: FeedQueryExecutor) {}

  /** Resolves scope, classifies records, folds pairs, and fetches limit+1 events in one statement. */
  async getFeed(input: FeedQueryInput): Promise<FeedQueryResult> {
    const { request, cursor, trustedQualityLabelerDids, includeSource } = input
    const policy = request.organizationQuality
    const result = await this.database.query<FeedQueryRow>(FEED_QUERY, [
      request.viewerDid,
      request.trustedEvaluators,
      policy !== undefined,
      (policy?.allowed ?? []) satisfies readonly OrganizationQuality[],
      policy?.includeUnrated ?? false,
      trustedQualityLabelerDids,
      request.kinds,
      cursor?.value ?? null,
      cursor?.uri ?? null,
      request.limit + 1,
      MAX_RESOLVED_AUTHOR_COUNT,
      FEED_COLLECTIONS,
      includeSource,
    ])

    const first = result.rows[0]
    const scopeCount = first?.scope_count ?? 0
    const metadataRows: FeedQueryMetadataRow[] = []
    const sourceRows: FeedQuerySourceRow[] = []

    for (const row of result.rows) {
      const isScopeMetadataOnly =
        row.uri === null &&
        row.cid === null &&
        row.collection === null &&
        row.actor_did === null &&
        row.kind === null &&
        row.sort_value === null
      if (isScopeMetadataOnly) continue
      if (
        row.uri === null ||
        row.cid === null ||
        row.collection === null ||
        row.actor_did === null ||
        row.kind === null ||
        row.sort_value === null
      ) {
        throw metadataInvariantError()
      }

      const metadata = {
        uri: row.uri,
        cid: row.cid,
        actorDid: row.actor_did,
        collection: row.collection,
        kind: row.kind,
        sortValue: row.sort_value,
      }
      if (!includeSource) {
        metadataRows.push(metadata)
        continue
      }

      if (
        row.selected_source_uri !== row.uri ||
        row.selected_source_cid !== row.cid ||
        row.selected_source_collection !== row.collection
      ) {
        throw sourceInvariantError()
      }
      sourceRows.push({ ...metadata, sourceValue: row.source_json })
    }

    return includeSource
      ? { includeSource: true, scopeCount, rows: sourceRows }
      : { includeSource: false, scopeCount, rows: metadataRows }
  }
}
