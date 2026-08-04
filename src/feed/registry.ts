import { FeedError, FeedErrorCode } from './errors.js'
import type { FeedKind, FeedParams, GetFeedSkeletonInput } from './types.js'

export type FeedPageMode = 'metadata' | 'with-source'

export interface InternalFeedRow {
  readonly uri: string
  readonly cid: string
  readonly collection: string
  readonly actorDid: string
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

export interface RegisteredFeed {
  readonly id: string
  readonly paramsType: string

  loadPage(
    params: FeedParams,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    params: FeedParams,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
}

export class FeedRegistry implements FeedPageLoader {
  readonly #feeds = new Map<string, RegisteredFeed>()

  constructor(feeds: readonly RegisteredFeed[]) {
    for (const feed of feeds) {
      if (this.#feeds.has(feed.id)) {
        throw new Error(
          `Feed registry contains duplicate feedId ${JSON.stringify(feed.id)}; register each feed identifier exactly once.`,
        )
      }
      this.#feeds.set(feed.id, feed)
    }
  }

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
    const feed = this.#feeds.get(input.feedId)
    if (feed === undefined) {
      throw new FeedError(
        FeedErrorCode.UnsupportedFeed,
        `feedId ${JSON.stringify(input.feedId)} is not registered by this service; use a supported feed identifier and retry.`,
      )
    }
    if (input.params.$type !== feed.paramsType) {
      throw new FeedError(
        FeedErrorCode.InvalidRequest,
        `params.$type ${JSON.stringify(input.params.$type)} does not match feedId ${JSON.stringify(input.feedId)}; use ${JSON.stringify(feed.paramsType)} and retry.`,
      )
    }

    return mode === 'metadata'
      ? feed.loadPage(input.params, 'metadata')
      : feed.loadPage(input.params, 'with-source')
  }
}
