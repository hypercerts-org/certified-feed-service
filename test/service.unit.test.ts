import { describe, expect, it } from 'vitest'

import type {
  FeedPageLoader,
  FeedPageMode,
  InternalFeedPage,
  InternalFeedRow,
  InternalSourceFeedRow,
} from '../src/feed/page-loader.js'
import { FeedService } from '../src/feed/service.js'
import type { GetFeedSkeletonInput } from '../src/feed/types.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const uri = `at://${actor}/org.hypercerts.claim.activity/3kpn`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const cursor = 'opaque-cursor-bytes'

class FakeFeedPageLoader implements FeedPageLoader {
  readonly calls: {
    readonly input: GetFeedSkeletonInput
    readonly mode: FeedPageMode
  }[] = []

  constructor(
    private readonly metadataPage: InternalFeedPage<InternalFeedRow>,
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
  ): Promise<
    | InternalFeedPage<InternalFeedRow>
    | InternalFeedPage<InternalSourceFeedRow>
  > {
    this.calls.push({ input, mode })
    if (mode !== 'metadata') {
      throw new Error('This skeleton-service fake supports metadata pages only.')
    }
    return this.metadataPage
  }
}

describe('FeedService', () => {
  it('projects metadata rows without changing the shared page cursor', async () => {
    const pages = new FakeFeedPageLoader({
      rows: [
        {
          uri,
          cid,
          actorDid: actor,
          collection: 'org.hypercerts.claim.activity',
          kind: 'cert.create',
          sortValue: '2026-07-21T10:00:00.000000Z',
        },
      ],
      cursor,
    })
    const service = new FeedService(pages)
    const input = { viewerDid: viewer, limit: 1 }

    await expect(service.getFeedSkeleton(input)).resolves.toEqual({
      items: [
        {
          id: uri,
          kind: 'cert.create',
          subject: { uri, cid },
          actorDid: actor,
          sortAt: '2026-07-21T10:00:00.000000Z',
        },
      ],
      cursor,
    })
    expect(pages.calls).toEqual([{ input, mode: 'metadata' }])
  })

  it('omits a cursor when the shared page has no next cursor', async () => {
    const pages = new FakeFeedPageLoader({ rows: [] })
    const service = new FeedService(pages)

    await expect(
      service.getFeedSkeleton({ viewerDid: viewer }),
    ).resolves.toEqual({ items: [] })
  })
})
