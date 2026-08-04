import { describe, expect, it } from 'vitest'

import { FeedErrorCode } from '../src/feed/errors.js'
import type {
  FeedPageMode,
  InternalFeedPage,
  InternalFeedRow,
  InternalSourceFeedRow,
  RegisteredFeed,
} from '../src/feed/registry.js'
import { FeedRegistry } from '../src/feed/registry.js'
import type { FeedParams } from '../src/feed/types.js'

const feedId = 'app.certified.feed.beta.defs#certifiedFeed'
const paramsType = 'app.certified.feed.beta.defs#certifiedFeedParams'
const actorDid = 'did:plc:ar7c4by46qjdydhdevvrndac'
const uri = `at://${actorDid}/org.hypercerts.claim.activity/3kpn`

const row: InternalFeedRow = {
  uri,
  cid: 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u',
  collection: 'org.hypercerts.claim.activity',
  actorDid,
  kind: 'cert.create',
  sortValue: '2026-07-21T10:00:00.000000Z',
}

class FakeRegisteredFeed implements RegisteredFeed {
  readonly loadCalls: Array<{
    readonly params: FeedParams
    readonly mode: FeedPageMode
  }> = []

  constructor(
    readonly id: string,
    readonly paramsType: string,
  ) {}

  loadPage(
    params: FeedParams,
    mode: 'metadata',
  ): Promise<InternalFeedPage<InternalFeedRow>>
  loadPage(
    params: FeedParams,
    mode: 'with-source',
  ): Promise<InternalFeedPage<InternalSourceFeedRow>>
  async loadPage(
    params: FeedParams,
    mode: FeedPageMode,
  ): Promise<InternalFeedPage<InternalFeedRow | InternalSourceFeedRow>> {
    this.loadCalls.push({ params, mode })
    return mode === 'metadata'
      ? { rows: [row] }
      : { rows: [{ ...row, sourceValue: { title: 'Source' } }] }
  }
}

describe('FeedRegistry', () => {
  it('dispatches a matching feed and params type', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])
    const params = { $type: paramsType, viewerDid: actorDid } as const

    await expect(
      registry.loadPage({ feedId, params }, 'metadata'),
    ).resolves.toEqual({ rows: [row] })
    expect(feed.loadCalls).toEqual([{ params, mode: 'metadata' }])
  })

  it('rejects duplicate feed identifiers at construction', () => {
    expect(
      () =>
        new FeedRegistry([
          new FakeRegisteredFeed(feedId, paramsType),
          new FakeRegisteredFeed(feedId, paramsType),
        ]),
    ).toThrowError(expect.objectContaining({ message: expect.stringContaining(feedId) }))
  })

  it('rejects an unknown feed before inspecting its params', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage(
        {
          feedId: 'app.certified.feed.beta.defs#missingFeed',
          params: { $type: 'malformed' },
        },
        'metadata',
      ),
    ).rejects.toMatchObject({ code: FeedErrorCode.UnsupportedFeed })
    expect(feed.loadCalls).toEqual([])
  })

  it('rejects params that do not match the selected registration', async () => {
    const feed = new FakeRegisteredFeed(feedId, paramsType)
    const registry = new FeedRegistry([feed])

    await expect(
      registry.loadPage(
        {
          feedId,
          params: { $type: 'app.certified.feed.beta.defs#otherParams' },
        },
        'metadata',
      ),
    ).rejects.toMatchObject({
      code: FeedErrorCode.InvalidRequest,
      message: expect.stringContaining(paramsType),
    })
    expect(feed.loadCalls).toEqual([])
  })
})
