import type { FeedPageLoader } from './page-loader.js'
import type {
  GetFeedSkeletonInput,
  GetFeedSkeletonOutput,
} from './types.js'

/** Application seam consumed by the skeleton XRPC transport. */
export interface FeedSkeletonReader {
  /** Generates one current-state skeleton page from a public request body. */
  getFeedSkeleton(input: GetFeedSkeletonInput): Promise<GetFeedSkeletonOutput>
}

/** Projects the shared metadata page into the public skeleton response. */
export class FeedService implements FeedSkeletonReader {
  constructor(private readonly pages: FeedPageLoader) {}

  /** Generates one current-state skeleton page without hydrating record bodies or actor profiles. */
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
