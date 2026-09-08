import { describe, expect, it } from 'vitest'

import { encodeCursor, timestampUriCursor } from '../src/feed/cursor.js'
import type {
  FeedPageLoader,
  FeedPageMode,
  InternalFeedPage,
  InternalFeedRow,
  InternalSourceFeedRow,
} from '../src/feed/registry.js'
import { FeedService } from '../src/feed/service.js'
import type { GetFeedSkeletonInput } from '../src/feed/types.js'

const feedId = 'org.hypercerts.feed.defs#hypercertsFeed'
const paramsType = 'org.hypercerts.feed.defs#hypercertsFeedParams'
const viewerDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actorDid = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const baseUri = `at://${actorDid}/org.hypercerts.claim.activity/`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'

const input: GetFeedSkeletonInput = {
  feedId,
  params: { $type: paramsType, viewerDid },
}

const row = (suffix: string, sortValue: string): InternalFeedRow => ({
  uri: `${baseUri}${suffix}`,
  cid,
  collection: 'org.hypercerts.claim.activity',
  actorDid,
  kind: 'cert.create',
  sortValue,
})

class FakePageLoader implements FeedPageLoader {
  readonly calls: Array<{
    readonly input: GetFeedSkeletonInput
    readonly mode: FeedPageMode
  }> = []

  constructor(private readonly page: InternalFeedPage<InternalFeedRow>) {}

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
    this.calls.push({ input, mode })
    if (mode === 'with-source') {
      return {
        rows: this.page.rows.map((item) => ({
          ...item,
          sourceValue: {},
        })),
        ...(this.page.cursor === undefined ? {} : { cursor: this.page.cursor }),
      }
    }
    return this.page
  }
}

describe('FeedService', () => {
  it('projects one registry-selected metadata page into the skeleton', async () => {
    const rows = [
      row('2', '2026-07-21T10:00:02.000000Z'),
      row('1', '2026-07-21T10:00:01.000000Z'),
    ]
    const cursor = encodeCursor(feedId, rows[1]!, timestampUriCursor)
    const pages = new FakePageLoader({ rows, cursor })
    const service = new FeedService(pages)

    await expect(service.getFeedSkeleton(input)).resolves.toEqual({
      feed: rows.map((item) => ({ subject: item.uri })),
      cursor,
    })
    expect(pages.calls).toEqual([{ input, mode: 'metadata' }])
  })

  it('omits the cursor when the selected page has none', async () => {
    const service = new FeedService(
      new FakePageLoader({
        rows: [row('1', '2026-07-21T10:00:01.000000Z')],
      }),
    )

    await expect(service.getFeedSkeleton(input)).resolves.toEqual(
      expect.not.objectContaining({ cursor: expect.anything() }),
    )
  })
})
