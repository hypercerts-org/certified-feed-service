import { performance } from 'node:perf_hooks'

import type { Metrics } from '../metrics.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import type { FeedQueryReader, FeedQueryResult } from './query.js'
import type {
  GetFeedSkeletonInput,
  GetFeedSkeletonOutput,
} from './types.js'
import { normalizeFeedRequest } from './validation.js'

/** Application seam consumed by the XRPC transport. */
export interface FeedSkeletonReader {
  /** Generates one current-state skeleton page from a public request body. */
  getFeedSkeleton(input: GetFeedSkeletonInput): Promise<GetFeedSkeletonOutput>
}

/** Coordinates validation, cursor handling, SQL execution, and response pagination. */
export class FeedService implements FeedSkeletonReader {
  /** Creates a service with immutable labeler trust configuration. */
  constructor(
    private readonly repository: FeedQueryReader,
    private readonly trustedQualityLabelerDids: readonly string[],
    private readonly metrics: Metrics,
  ) {}

  /** Generates one current-state skeleton page without hydrating record bodies or actor profiles. */
  async getFeedSkeleton(
    input: GetFeedSkeletonInput,
  ): Promise<GetFeedSkeletonOutput> {
    const request = normalizeFeedRequest(input)
    const cursor = decodeCursor(request.cursor)

    const startedAt = performance.now()
    let result: FeedQueryResult
    try {
      result = await this.repository.getFeed({
        request,
        ...(cursor ? { cursor } : {}),
        trustedQualityLabelerDids: this.trustedQualityLabelerDids,
      })
    } finally {
      this.metrics.observeDatabase(
        'feed',
        (performance.now() - startedAt) / 1_000,
      )
    }

    const hasNext = result.rows.length > request.limit
    const page = hasNext ? result.rows.slice(0, request.limit) : result.rows
    const items = page.map((row) => ({
      id: row.uri,
      kind: row.kind,
      subject: { uri: row.uri, cid: row.cid },
      actorDid: row.actorDid,
      feedTimestamp: row.sortValue,
    }))
    this.metrics.observeResult(items.map((item) => item.kind))

    const last = page.at(-1)
    return {
      items,
      ...(hasNext && last
        ? { cursor: encodeCursor(last.sortValue, last.uri) }
        : {}),
    }
  }
}
