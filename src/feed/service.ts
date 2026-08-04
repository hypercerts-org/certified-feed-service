import type { FeedPageLoader } from './registry.js'
import type {
  GetFeedSkeletonInput,
  GetFeedSkeletonOutput,
} from './types.js'

/** Application boundary consumed by the skeleton XRPC transport. */
export interface FeedSkeletonReader {
  getFeedSkeleton(input: GetFeedSkeletonInput): Promise<GetFeedSkeletonOutput>
}

/** Projects one registry-selected metadata page into the public skeleton. */
export class FeedService implements FeedSkeletonReader {
  constructor(private readonly pages: FeedPageLoader) {}

  async getFeedSkeleton(
    input: GetFeedSkeletonInput,
  ): Promise<GetFeedSkeletonOutput> {
    const page = await this.pages.loadPage(input, 'metadata')
    return {
      items: page.rows.map((row) => ({
        id: row.uri,
        kind: row.kind,
        subject: { uri: row.uri, cid: row.cid },
        actorDid: row.actorDid,
        feedTimestamp: row.sortValue,
      })),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    }
  }
}
