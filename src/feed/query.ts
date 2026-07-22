import { readFileSync } from 'node:fs'

import type { Database } from '../database.js'
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

interface FeedQueryRow {
  scope_count: number
  uri: string | null
  cid: string | null
  actor_did: string | null
  kind: FeedKind | null
  sort_value: string | null
}

/** Parameters consumed by the standalone SQL adapter. */
export interface FeedQueryInput {
  /** Validated and normalized public request. */
  readonly request: NormalizedFeedRequest
  /** Validated keyset cursor, if this is not the first page. */
  readonly cursor?: FeedCursor
  /** Trusted service-configured Orglabeler DIDs. */
  readonly trustedQualityLabelerDids: readonly string[]
}

/** One database result before the service trims the limit+1 sentinel row. */
export interface FeedQueryResult {
  /** Number of accounts remaining after all scope membership rules. */
  readonly scopeCount: number
  /** Fully classified rows in deterministic descending order. */
  readonly rows: readonly {
    readonly uri: string
    readonly cid: string
    readonly actorDid: string
    readonly kind: FeedKind
    readonly sortValue: string
  }[]
}

/** Seam used by FeedService to execute the database-owned feed pipeline. */
export interface FeedQueryReader {
  /** Resolves a feed request into a scope count and limit+1 classified rows. */
  getFeed(input: FeedQueryInput): Promise<FeedQueryResult>
}

/** Read-only adapter that owns the complete current-state feed query. */
export class FeedRepository implements FeedQueryReader {
  /** Creates the adapter over the service's bounded read-only pool. */
  constructor(private readonly database: Database) {}

  /** Resolves scope, classifies records, folds pairs, and fetches limit+1 events in one statement. */
  async getFeed(input: FeedQueryInput): Promise<FeedQueryResult> {
    const { request, cursor, trustedQualityLabelerDids } = input
    const policy = request.organizationQuality
    const result = await this.database.query<FeedQueryRow>(FEED_QUERY, [
      request.viewerDid,
      request.authors,
      request.hasExplicitAuthors,
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
    ])

    const first = result.rows[0]
    const scopeCount = first?.scope_count ?? 0
    const rows = result.rows.flatMap((row) => {
      if (
        row.uri === null ||
        row.cid === null ||
        row.actor_did === null ||
        row.kind === null ||
        row.sort_value === null
      ) {
        return []
      }
      return [
        {
          uri: row.uri,
          cid: row.cid,
          actorDid: row.actor_did,
          kind: row.kind,
          sortValue: row.sort_value,
        },
      ]
    })

    return { scopeCount, rows }
  }
}
