import { describe, expect, it } from 'vitest'

import { FeedError } from '../src/feed/errors.js'
import {
  PostgresFeedPageLoader,
} from '../src/feed/page-loader.js'
import type {
  FeedQueryInput,
  FeedQueryReader,
  FeedQueryResult,
} from '../src/feed/query.js'
import { Metrics } from '../src/metrics.js'

const viewer = 'did:plc:ar7c4by46qjdydhdevvrndac'
const actor = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const baseUri = `at://${actor}/org.hypercerts.claim.activity/`
const cid = 'bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u'
const expectedCursor =
  'eyJ2ZXJzaW9uIjoyLCJ2YWx1ZSI6IjIwMjYtMDctMjFUMTA6MDA6MDIuMDAwMDAwWiIsInVyaSI6ImF0Oi8vZGlkOnBsYzpld3ZpN254enlvdW42emh4cmhzNjRvaXovb3JnLmh5cGVyY2VydHMuY2xhaW0uYWN0aXZpdHkvMiJ9'

const metadataRow = (suffix: string, sortValue: string) => ({
  uri: `${baseUri}${suffix}`,
  cid,
  actorDid: actor,
  collection: 'org.hypercerts.claim.activity',
  kind: 'cert.create' as const,
  sortValue,
})

class FakeFeedReader implements FeedQueryReader {
  readonly calls: FeedQueryInput[] = []

  constructor(
    private readonly result: FeedQueryResult,
    private readonly failure?: Error,
  ) {}

  async getFeed(input: FeedQueryInput): Promise<FeedQueryResult> {
    this.calls.push(input)
    if (this.failure) throw this.failure
    return this.result
  }
}

describe('PostgresFeedPageLoader', () => {
  it('normalizes once, invokes the repository once, trims the sentinel, and preserves cursor bytes', async () => {
    const reader = new FakeFeedReader({
      includeSource: false,
      scopeCount: 1,
      rows: [
        metadataRow('3', '2026-07-21T10:00:03.000000Z'),
        metadataRow('2', '2026-07-21T10:00:02.000000Z'),
        metadataRow('1', '2026-07-21T10:00:01.000000Z'),
      ],
    })
    const loader = new PostgresFeedPageLoader(
      reader,
      [viewer],
      new Metrics(),
    )

    const page = await loader.loadPage(
      { viewerDid: viewer, authors: [actor], limit: 2 },
      'metadata',
    )

    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]).toMatchObject({
      includeSource: false,
      trustedQualityLabelerDids: [viewer],
      request: {
        viewerDid: viewer,
        authors: [actor],
        limit: 2,
      },
    })
    expect(page.rows.map((row) => row.uri)).toEqual([
      `${baseUri}3`,
      `${baseUri}2`,
    ])
    expect(page.cursor).toBe(expectedCursor)
  })

  it('returns exact source rows in with-source mode and omits a cursor on a final page', async () => {
    const sourceValue = { $type: 'org.hypercerts.claim.activity', title: 'A' }
    const reader = new FakeFeedReader({
      includeSource: true,
      scopeCount: 1,
      rows: [
        {
          ...metadataRow('1', '2026-07-21T10:00:01.000000Z'),
          sourceValue,
        },
      ],
    })
    const loader = new PostgresFeedPageLoader(reader, [], new Metrics())

    await expect(
      loader.loadPage(
        { viewerDid: viewer, authors: [actor] },
        'with-source',
      ),
    ).resolves.toEqual({
      rows: [
        {
          ...metadataRow('1', '2026-07-21T10:00:01.000000Z'),
          sourceValue,
        },
      ],
    })
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]?.includeSource).toBe(true)
  })

  it('rejects an oversized resolved scope without truncating it', async () => {
    const loader = new PostgresFeedPageLoader(
      new FakeFeedReader({ includeSource: false, scopeCount: 501, rows: [] }),
      [],
      new Metrics(),
    )

    await expect(
      loader.loadPage({ viewerDid: viewer, authors: [] }, 'metadata'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FeedError>>({ code: 'FEED_SCOPE_TOO_LARGE' }),
    )
  })

  it('records feed database timing when the repository rejects', async () => {
    const metrics = new Metrics()
    const loader = new PostgresFeedPageLoader(
      new FakeFeedReader(
        { includeSource: false, scopeCount: 0, rows: [] },
        new Error('database unavailable'),
      ),
      [],
      metrics,
    )

    await expect(
      loader.loadPage({ viewerDid: viewer }, 'metadata'),
    ).rejects.toThrow('database unavailable')
    expect(await metrics.registry.metrics()).toContain(
      'certified_feed_database_duration_seconds_count{operation="feed"} 1',
    )
  })
})
