import { performance } from 'node:perf_hooks'

import type { Metrics } from '../metrics.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import type { FeedQueryReader, FeedQueryResult } from './query.js'
import type {
  FeedKind,
  GetFeedSkeletonInput,
} from './types.js'
import { normalizeFeedRequest } from './validation.js'

/** Controls whether a page includes only event metadata or exact source values. */
export type FeedPageMode = 'metadata' | 'with-source'

/** Internal event metadata shared by skeleton and hydrated feed projections. */
export interface InternalFeedRow {
  readonly uri: string
  readonly cid: string
  readonly actorDid: string
  readonly collection: string
  readonly kind: FeedKind
  readonly sortValue: string
}

/** Internal event row with its exact same-statement source value. */
export interface InternalSourceFeedRow extends InternalFeedRow {
  readonly sourceValue: unknown
}

/** One trimmed internal page and its optional next-page cursor. */
export interface InternalFeedPage<Row extends InternalFeedRow> {
  readonly rows: readonly Row[]
  readonly cursor?: string
}

/** Shared internal page seam used independently by both public feed services. */
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

const modeInvariantError = (): Error =>
  new Error(
    'Feed page loader mode invariant failed: the repository returned a result for a different source mode; verify the page-loader mode mapping before serving feed requests.',
  )

/** Coordinates the shared request, query, pagination, and metrics policy. */
export class PostgresFeedPageLoader implements FeedPageLoader {
  constructor(
    private readonly repository: FeedQueryReader,
    private readonly trustedQualityLabelerDids: readonly string[],
    private readonly metrics: Metrics,
  ) {}

  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    input: GetFeedSkeletonInput,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
  async loadPage(
    input: GetFeedSkeletonInput,
    mode: FeedPageMode,
  ): Promise<InternalFeedPage<InternalFeedRow | InternalSourceFeedRow>> {
    const request = normalizeFeedRequest(input)
    const cursor = decodeCursor(request.cursor)

    const startedAt = performance.now()
    let result: FeedQueryResult
    try {
      result = await this.repository.getFeed({
        request,
        ...(cursor ? { cursor } : {}),
        trustedQualityLabelerDids: this.trustedQualityLabelerDids,
        includeSource: mode === 'with-source',
      })
    } finally {
      this.metrics.observeDatabase(
        'feed',
        (performance.now() - startedAt) / 1_000,
      )
    }

    const hasNext = result.rows.length > request.limit
    const rows = hasNext ? result.rows.slice(0, request.limit) : result.rows
    this.metrics.observeResult(rows.map((row) => row.kind))

    const last = rows.at(-1)
    const pageSuffix =
      hasNext && last
        ? { cursor: encodeCursor(last.sortValue, last.uri) }
        : {}

    if (mode === 'metadata') {
      if (result.includeSource) throw modeInvariantError()
      return { rows, ...pageSuffix }
    }
    if (!result.includeSource) throw modeInvariantError()
    return { rows, ...pageSuffix }
  }
}
